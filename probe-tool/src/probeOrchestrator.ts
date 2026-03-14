import { llmCompleteJSON } from "./llmClient";
import { executePlan } from "./executionEngine";
import type {
    GoalInput,
    ParsedGoal,
    WorkflowPlan,
    AttemptTrace,
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

    return llmCompleteJSON<WorkflowPlan>(PLAN_SYSTEM_PROMPT, userMessage);
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

    return llmCompleteJSON<WorkflowPlan>(REPAIR_SYSTEM_PROMPT, userMessage);
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
