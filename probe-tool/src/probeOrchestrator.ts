import { llmCompleteJSON } from "./llmClient";
import { executePlan } from "./executionEngine";
import { diagnosticsPromptSummary, inferAttemptDiagnostics } from "./diagnostics";
import type {
    GoalInput,
    ParsedGoal,
    WorkflowPlan,
    AttemptTrace,
    WorkflowStep,
} from "./types";

const MAX_ATTEMPTS_DEFAULT = 5;

// ─── LLM prompt helpers ───────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are an API integration expert who probes unknown legacy REST APIs.
Your job is to produce a concrete step-by-step plan (a WorkflowPlan) that achieves a given integration goal.

IMPORTANT RULES:
- Many legacy APIs have incorrect or outdated documentation. Method names and parameter names may be wrong.
- If a write operation is needed, always add a final read-back step to verify the write succeeded.
- Path templates use {{varName}} tokens. Use extractVariables to capture response data for subsequent steps.
- When creating mutable resources like orders or invoices, prefer unique IDs that include {{runId}} so repeated probe runs do not collide with earlier test data.
- Prefer the minimal working set of steps. Do not invent endpoints that are not in the docs.
- When uncertain about a field name (e.g. commodity_id vs commodity_code_id), pick the most likely one and note the alternative in fallbackNote.

Return ONLY raw JSON matching this exact shape (no markdown, no prose):
{
  "goalId": "<same goalId you received>",
  "reasoning": "<why you chose this approach and what alternatives you considered>",
  "steps": [
    {
      "stepId": "step_1",
      "description": "<one-line description>",
      "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      "path": "/api/{{apiVersion}}/...",
      "query": { "key": "value or {{varToken}}" },
      "headers": {},
      "body": { ... },
      "extractVariables": { "varName": "dot.path.in.response" },
      "isValidationStep": false
    }
  ],
  "fallbackNote": "<what to try differently if this plan fails>"
}`;

const REPAIR_SYSTEM_PROMPT = `You are an API integration expert debugging a failed probe attempt against a legacy REST API.
Given the failure evidence, produce a REVISED WorkflowPlan that avoids the known failure.

Common causes and fixes:
- HTTP 404 or 405: try a different HTTP method (POST vs PUT vs GET).
- HTTP 400 with missing field error: the parameter name may differ from the docs (e.g. commodity_id vs commodity_code_id). Try the alternative.
- HTTP 400 with invalid token/template: the workflow likely needs a pre-step (GET template first, then use the token in the PUT).
- HTTP 401: check auth header name and value.
- Validation step returns wrong values: the write step may have used the wrong field names.

Return ONLY raw JSON in the same WorkflowPlan shape. No markdown, no explanations outside the "reasoning" field.`;

// ─── Plan Generation ──────────────────────────────────────────────────────────

async function generateInitialPlan(
    goal: ParsedGoal,
    input: GoalInput
): Promise<WorkflowPlan> {
    const userMessage = `API Documentation:
${input.apiDocumentation}

Customer ID: ${input.customerId}
API Version: ${input.apiVersion}
API Base URL: ${input.apiBaseUrl}
Available substitution vars: customerId={{customerId}}, apiVersion={{apiVersion}}, runId={{runId}}

Goal to achieve:
ID: ${goal.id}
Description: ${goal.rawGoal}
Required operations: ${goal.requiredOperations.join(", ")}
Access level: ${goal.accessLevel}
Success criteria: ${goal.successCriteria.join("; ")}
Requires write validation: ${goal.requiresWriteValidation}

Produce the WorkflowPlan JSON now.`;

    const raw = await llmCompleteJSON<unknown>(PLAN_SYSTEM_PROMPT, userMessage);
    return normalizeWorkflowPlan(raw, goal.id);
}

async function generateRepairPlan(
    goal: ParsedGoal,
    input: GoalInput,
    failedAttempt: AttemptTrace,
    allPriorAttempts: AttemptTrace[]
): Promise<WorkflowPlan> {
    const priorPlansText = allPriorAttempts
        .map((a) => {
            const failedStep = a.stepTraces.find((s) => !s.success);
            return `Attempt ${a.attemptIndex + 1} (plan reasoning: "${a.plan.reasoning}"):
  Failed at step: ${a.failedAtStep ?? "unknown"}
  Reason: ${a.failureReason ?? "unknown"}
  Failed request: ${JSON.stringify(failedStep?.request ?? null, null, 2).slice(0, 600)}
  Failed response: ${JSON.stringify(failedStep?.response ?? null, null, 2).slice(0, 600)}
    Diagnostics:
${diagnosticsPromptSummary(a.diagnostics ?? [])}
  Fallback hint from prior plan: ${a.plan.fallbackNote ?? "none"}`;
        })
        .join("\n\n");

    const userMessage = `API Documentation:
${input.apiDocumentation}

Customer ID: ${input.customerId}
API Version: ${input.apiVersion}
API Base URL: ${input.apiBaseUrl}
Available substitution vars: customerId={{customerId}}, apiVersion={{apiVersion}}, runId={{runId}}

Goal to achieve:
ID: ${goal.id}
Description: ${goal.rawGoal}
Required operations: ${goal.requiredOperations.join(", ")}
Success criteria: ${goal.successCriteria.join("; ")}
Requires write validation: ${goal.requiresWriteValidation}

Prior failed attempts:
${priorPlansText}

Produce a revised WorkflowPlan JSON that avoids all known failure patterns above.`;

    try {
        const raw = await llmCompleteJSON<unknown>(REPAIR_SYSTEM_PROMPT, userMessage);
        return normalizeWorkflowPlan(raw, goal.id);
    } catch {
        return buildHeuristicRepairPlan(goal, input, failedAttempt);
    }
}

function buildHeuristicRepairPlan(
    goal: ParsedGoal,
    input: GoalInput,
    failedAttempt: AttemptTrace
): WorkflowPlan {
    const plan = clonePlan(failedAttempt.plan);
    const failedTrace = failedAttempt.stepTraces.find((step) => !step.success);
    const errorText = JSON.stringify(failedTrace?.response.body ?? failedTrace?.error ?? "").toLowerCase();
    const diagnostics = failedAttempt.diagnostics ?? [];

    if (hasDiagnostic(diagnostics, "MISSING_PREREQUISITE_STEP") || errorText.includes("preflight")) {
        addOrderPreflight(plan, input);
        applyHeaderToOrderSteps(plan, "x-preflight-token", "{{preflightToken}}");
        updateOrderMutationShape(plan);
    }

    if (hasDiagnostic(diagnostics, "METHOD_MISMATCH")) {
        toggleFailingMutationMethod(plan, failedAttempt.failedAtStep);
    }

    if (hasDiagnostic(diagnostics, "PARAMETER_MISMATCH") || errorText.includes("required:")) {
        applyFieldAliasesFromError(plan, errorText);
    }

    return {
        ...plan,
        goalId: goal.id,
        reasoning:
            "Heuristic repair plan generated from failure diagnostics after LLM repair output was unusable.",
        fallbackNote: "Applied diagnostic-based repair heuristics.",
    };
}

function clonePlan(plan: WorkflowPlan): WorkflowPlan {
    return JSON.parse(JSON.stringify(plan)) as WorkflowPlan;
}

function hasDiagnostic(
    diagnostics: AttemptTrace["diagnostics"],
    code: string
): boolean {
    return (diagnostics ?? []).some((diagnostic) => diagnostic.code === code);
}

function addOrderPreflight(plan: WorkflowPlan, input: GoalInput): void {
    const hasPreflight = plan.steps.some((step) => step.path.includes("/orders/preflight"));
    if (hasPreflight) {
        return;
    }

    const orderStep = plan.steps.find((step) => step.path.includes("/orders/"));
    if (!orderStep) {
        return;
    }

    const preflightPath = orderStep.path.replace(/\/orders(?:\/.*)?$/, "/orders/preflight");
    plan.steps.unshift({
        stepId: "step_preflight",
        description: "Fetch undocumented preflight token for order operations",
        method: "POST",
        path: preflightPath,
        body: {
            customer_id: "{{customerId}}"
        },
        extractVariables: {
            preflightToken: "preflight_token"
        }
    });

    plan.steps.forEach((step) => {
        if (step.path.includes("/orders/") && step.query?.customer_id === undefined && step.path.includes("/template")) {
            step.query = {
                ...(step.query ?? {}),
                customer_id: "{{customerId}}"
            };
        }
    });
}

function applyHeaderToOrderSteps(plan: WorkflowPlan, headerName: string, headerValue: string): void {
    plan.steps.forEach((step) => {
        if (step.path.includes("/orders/")) {
            step.headers = {
                ...(step.headers ?? {}),
                [headerName]: headerValue,
            };
        }
    });
}

function updateOrderMutationShape(plan: WorkflowPlan): void {
    plan.steps.forEach((step) => {
        if (!step.path.includes("/orders/") || !step.body || typeof step.body !== "object" || Array.isArray(step.body)) {
            return;
        }

        if (step.method === "PUT") {
            step.method = "POST";
        }

        const body = step.body as Record<string, unknown>;
        if (typeof body.commodity_id === "string" && body.commodity_code_id === undefined) {
            body.commodity_code_id = body.commodity_id;
            delete body.commodity_id;
        }

        if (Array.isArray(body.line_items)) {
            body.line_items = body.line_items.map((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) {
                    return item;
                }
                const row = { ...(item as Record<string, unknown>) };
                if (row.quantity !== undefined && row.qty === undefined) {
                    row.qty = row.quantity;
                    delete row.quantity;
                }
                return row;
            });
        }
    });
}

function toggleFailingMutationMethod(plan: WorkflowPlan, failedAtStep?: string): void {
    const step = plan.steps.find((item) => item.stepId === failedAtStep) ??
        [...plan.steps].reverse().find((item) => item.method === "POST" || item.method === "PUT");

    if (!step) {
        return;
    }

    if (step.method === "POST") {
        step.method = "PUT";
    } else if (step.method === "PUT") {
        step.method = "POST";
    }
}

function applyFieldAliasesFromError(plan: WorkflowPlan, errorText: string): void {
    plan.steps.forEach((step) => {
        if (step.extractVariables) {
            remapExtractPath(step.extractVariables, errorText, "invoice_ref", "invoice_id");
            remapExtractPath(step.extractVariables, errorText, "client_id", "customer_id");
            remapExtractPath(step.extractVariables, errorText, "total_amount", "total");
            remapExtractPath(step.extractVariables, errorText, "issued_on", "issued_at");
        }

        if (step.query) {
            if (errorText.includes("customer_ref") && step.query.customer_ref === undefined && step.query.customer_id !== undefined) {
                step.query.customer_ref = step.query.customer_id;
                delete step.query.customer_id;
            }
            if (errorText.includes("period") && step.query.period === undefined && step.query.month !== undefined) {
                step.query.period = step.query.month;
                delete step.query.month;
            }
        }

        if (!step.body || typeof step.body !== "object" || Array.isArray(step.body)) {
            return;
        }

        const body = step.body as Record<string, unknown>;

        remapBodyField(body, errorText, "invoice_ref", "invoice_id");
        remapBodyField(body, errorText, "client_id", "customer_id");
        remapBodyField(body, errorText, "total_amount", "total");
        remapBodyField(body, errorText, "issued_on", "issued_at");
        remapBodyField(body, errorText, "commodity_code_id", "commodity_id");
        remapBodyField(body, errorText, "commodity_id", "commodity_code_id");

        if (errorText.includes("qty") && Array.isArray(body.line_items)) {
            body.line_items = body.line_items.map((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) {
                    return item;
                }
                const row = { ...(item as Record<string, unknown>) };
                if (row.qty === undefined && row.quantity !== undefined) {
                    row.qty = row.quantity;
                    delete row.quantity;
                }
                return row;
            });
        }
    });
}

function remapBodyField(
    body: Record<string, unknown>,
    errorText: string,
    preferredKey: string,
    fallbackKey: string
): void {
    if (!errorText.includes(preferredKey)) {
        return;
    }

    if (body[preferredKey] === undefined && body[fallbackKey] !== undefined) {
        body[preferredKey] = body[fallbackKey];
        delete body[fallbackKey];
    }
}

function remapExtractPath(
    extractVariables: Record<string, string>,
    errorText: string,
    preferredPath: string,
    fallbackPath: string
): void {
    if (!errorText.includes(preferredPath)) {
        return;
    }

    for (const [key, value] of Object.entries(extractVariables)) {
        if (value === fallbackPath) {
            extractVariables[key] = preferredPath;
        }
    }
}

function normalizeWorkflowPlan(raw: unknown, goalId: string): WorkflowPlan {
    const root = pickPlanRoot(raw);
    const stepsRaw = root.steps;

    if (!Array.isArray(stepsRaw)) {
        throw new Error(
            `LLM returned invalid WorkflowPlan for ${goalId}: missing steps array.`
        );
    }

    const steps: WorkflowStep[] = stepsRaw.map((step, index) => {
        if (!step || typeof step !== "object") {
            throw new Error(
                `LLM returned invalid WorkflowStep at index ${index} for ${goalId}.`
            );
        }

        const record = step as Record<string, unknown>;
        const method = typeof record.method === "string"
            ? record.method.toUpperCase()
            : "GET";
        const path = typeof record.path === "string" ? record.path : "";

        if (!path.startsWith("/")) {
            throw new Error(
                `LLM returned invalid path for step ${index + 1} in ${goalId}: ${JSON.stringify(path)}`
            );
        }

        return {
            stepId:
                typeof record.stepId === "string"
                    ? record.stepId
                    : `step_${index + 1}`,
            description:
                typeof record.description === "string"
                    ? record.description
                    : `Generated step ${index + 1}`,
            method: coerceMethod(method),
            path,
            query: asStringMap(record.query),
            headers: asStringMap(record.headers),
            body: record.body,
            extractVariables: asStringMap(record.extractVariables),
            isValidationStep: record.isValidationStep === true,
        };
    });

    return {
        goalId:
            typeof root.goalId === "string" && root.goalId.length > 0
                ? root.goalId
                : goalId,
        reasoning:
            typeof root.reasoning === "string"
                ? root.reasoning
                : "No reasoning provided.",
        steps,
        fallbackNote:
            typeof root.fallbackNote === "string" ? root.fallbackNote : undefined,
    };
}

function pickPlanRoot(raw: unknown): Record<string, unknown> {
    if (Array.isArray(raw)) {
        return { steps: raw };
    }

    if (!raw || typeof raw !== "object") {
        throw new Error("LLM returned non-object WorkflowPlan response.");
    }

    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.steps)) {
        return record;
    }

    const discovered = findPlanRoot(record);
    if (discovered) {
        return discovered;
    }

    return record;
}

function findPlanRoot(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    if (Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (Array.isArray(record.steps)) {
        return record;
    }

    for (const nested of Object.values(record)) {
        const found = findPlanRoot(nested);
        if (found) {
            return found;
        }
    }

    return undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string") {
            result[key] = item;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

function coerceMethod(value: string): WorkflowStep["method"] {
    if (value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE") {
        return value;
    }
    return "GET";
}

// ─── Probe Loop ───────────────────────────────────────────────────────────────

/**
 * Probe a single goal through up to maxAttempts LLM-plan→execute→evaluate cycles.
 * Returns all attempt traces (caller is responsible for final validation).
 */
export async function probeGoal(
    goal: ParsedGoal,
    input: GoalInput,
    maxAttempts?: number
): Promise<AttemptTrace[]> {
    const runId = `${Date.now().toString(36)}_${goal.id}`;
    const limit =
        maxAttempts ??
        (process.env.MAX_PROBE_ATTEMPTS
            ? parseInt(process.env.MAX_PROBE_ATTEMPTS, 10)
            : MAX_ATTEMPTS_DEFAULT);

    const initialContext: Record<string, unknown> = {
        customerId: input.customerId,
        apiVersion: input.apiVersion,
        runId,
    };

    const allAttempts: AttemptTrace[] = [];

    for (let i = 0; i < limit; i++) {
        console.log(
            `  [Probe] Goal "${goal.id}" – attempt ${i + 1}/${limit}…`
        );

        let plan: WorkflowPlan;
        if (i === 0) {
            plan = await generateInitialPlan(goal, input);
        } else {
            plan = await generateRepairPlan(
                goal,
                input,
                allAttempts[allAttempts.length - 1],
                allAttempts
            );
        }

        const attempt = await executePlan(
            plan,
            input.apiBaseUrl,
            input.authHeader,
            initialContext
        );
        attempt.attemptIndex = i;
        attempt.goalId = goal.id;
        attempt.diagnostics = inferAttemptDiagnostics(attempt);

        allAttempts.push(attempt);

        if (attempt.succeeded) {
            console.log(`  [Probe] Goal "${goal.id}" succeeded on attempt ${i + 1}.`);
            break;
        } else {
            console.log(
                `  [Probe] Goal "${goal.id}" failed at step "${attempt.failedAtStep}": ${attempt.failureReason}`
            );
        }
    }

    if (!allAttempts[allAttempts.length - 1].succeeded) {
        console.warn(
            `  [Probe] Goal "${goal.id}" exhausted all ${limit} attempts without success.`
        );
    }

    return allAttempts;
}
