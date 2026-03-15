import { llmCompleteJSON } from "./llmClient";
import type {
    ParsedGoal,
    AttemptTrace,
    GoalValidationReport,
    FieldValidation,
} from "./types";

const SYSTEM_PROMPT = `You are an API integration validation expert.
Given a parsed goal, its success criteria, and the full trace of the last successful execution attempt, produce a GoalValidationReport as JSON.

Rules:
- Check every field mentioned in the success criteria against actual response values.
- For write goals, the validation MUST include a read-back check: compare fields submitted in the write request against the fields returned by the subsequent GET.
- Mark status as "success" only when ALL field validations pass.
- Mark status as "partial" if some (but not all) checks pass.
- Mark status as "failed" if the attempt never succeeded or critical fields are wrong.
- Be precise in the "note" of each FieldValidation – state exactly what was expected and what was found.

Return ONLY raw JSON matching this exact shape (no markdown):
{
  "goalId": "<goalId>",
  "rawGoal": "<rawGoal string>",
  "status": "success" | "partial" | "failed",
  "fieldValidations": [
    {
      "field": "order.commodity_id",
      "expected": "metal",
      "actual": "metal",
      "passed": true,
      "note": ""
    }
  ],
  "summary": "<one paragraph human-readable explanation of the overall result>",
  "successfulSteps": ["step_1", "step_2"],
  "failedSteps": []
}`;

export async function validateGoal(
    goal: ParsedGoal,
    attempts: AttemptTrace[]
): Promise<GoalValidationReport> {
    const lastAttempt = attempts[attempts.length - 1];

    if (!lastAttempt) {
        return buildFailedReport(goal, "No probe attempts were made for this goal.");
    }

    if (!lastAttempt.succeeded) {
        const failureReason = lastAttempt.failureReason ?? "unknown";
        return buildFailedReport(
            goal,
            `All ${attempts.length} attempt(s) failed. Last failure: ${failureReason}`
        );
    }

    const tracesSummary = lastAttempt.stepTraces.map((t) => ({
        stepId: t.stepId,
        method: t.request.method,
        url: t.request.url,
        requestBody: t.request.body,
        responseStatus: t.response.status,
        responseBody: t.response.body,
        extractedVariables: t.extractedVariables,
        success: t.success,
    }));

    const userMessage = `Goal ID: ${goal.id}
Raw goal: ${goal.rawGoal}
Access level: ${goal.accessLevel}
Success criteria:
${goal.successCriteria.map((c) => `- ${c}`).join("\n")}
Requires write validation: ${goal.requiresWriteValidation}

Execution trace (last attempt – attempt ${lastAttempt.attemptIndex + 1}):
${JSON.stringify(tracesSummary, null, 2)}

Produce the GoalValidationReport JSON now.`;

    const report = await llmCompleteJSON<GoalValidationReport>(
        SYSTEM_PROMPT,
        userMessage
    );

    const deterministicValidations = buildDeterministicValidations(lastAttempt);
    if (deterministicValidations.length > 0) {
        report.fieldValidations = mergeFieldValidations(
            report.fieldValidations,
            deterministicValidations
        );
    }

    // Ensure IDs are populated in case the LLM omits them
    report.goalId = goal.id;
    report.rawGoal = goal.rawGoal;

    const failedCount = report.fieldValidations.filter((field) => !field.passed).length;
    const totalCount = report.fieldValidations.length;

    if (totalCount === 0) {
        report.status = "partial";
        report.summary = `${report.summary} Validation returned no field-level checks, so the result is treated as partial.`;
    } else if (failedCount === 0) {
        report.status = "success";
    } else if (failedCount < totalCount) {
        report.status = "partial";
    } else {
        report.status = "failed";
    }

    return report;
}

function buildFailedReport(
    goal: ParsedGoal,
    reason: string
): GoalValidationReport {
    const failReport: FieldValidation[] = [];
    return {
        goalId: goal.id,
        rawGoal: goal.rawGoal,
        status: "failed",
        fieldValidations: failReport,
        summary: reason,
        successfulSteps: [],
        failedSteps: [],
    };
}

function buildDeterministicValidations(attempt: AttemptTrace): FieldValidation[] {
    const writeStep = attempt.stepTraces.find(
        (trace) =>
            (trace.request.method === "POST" ||
                trace.request.method === "PUT" ||
                trace.request.method === "PATCH") &&
            trace.request.body !== null &&
            typeof trace.request.body === "object"
    );

    const validationStep = attempt.stepTraces.find(
        (trace) => trace.stepId === attempt.plan.steps.find((step) => step.isValidationStep)?.stepId
    );

    if (!writeStep || !validationStep || validationStep.response.body === null) {
        return [];
    }

    const validations: FieldValidation[] = [];
    compareExpectedToActual(
        writeStep.request.body,
        validationStep.response.body,
        "",
        validations
    );

    return validations;
}

function compareExpectedToActual(
    expected: unknown,
    actual: unknown,
    path: string,
    validations: FieldValidation[]
): void {
    if (expected === null || expected === undefined) {
        return;
    }

    if (Array.isArray(expected)) {
        const actualArray = Array.isArray(actual) ? actual : [];
        expected.forEach((item, index) => {
            compareExpectedToActual(
                item,
                actualArray[index],
                `${path}[${index}]`,
                validations
            );
        });
        return;
    }

    if (typeof expected === "object") {
        const expectedObject = expected as Record<string, unknown>;
        const actualObject = actual && typeof actual === "object"
            ? (actual as Record<string, unknown>)
            : {};

        for (const [key, value] of Object.entries(expectedObject)) {
            if (key === "template_token") {
                continue;
            }

            const nextPath = path ? `${path}.${key}` : key;
            const actualValue = resolveActualValue(actualObject, key);
            compareExpectedToActual(value, actualValue, nextPath, validations);
        }
        return;
    }

    validations.push({
        field: path,
        expected,
        actual: actual ?? null,
        passed: expected === actual,
        note:
            expected === actual
                ? undefined
                : `Expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual ?? null)}.`
    });
}

function resolveActualValue(
    actualObject: Record<string, unknown>,
    expectedKey: string
): unknown {
    if (actualObject[expectedKey] !== undefined) {
        return actualObject[expectedKey];
    }

    for (const alias of aliasesFor(expectedKey)) {
        if (actualObject[alias] !== undefined) {
            return actualObject[alias];
        }
    }

    return actualObject[expectedKey];
}

function aliasesFor(key: string): string[] {
    switch (key) {
        case "invoice_id":
            return ["invoice_ref"];
        case "customer_id":
            return ["client_id", "customer_ref"];
        case "total":
            return ["total_amount", "expenses_total"];
        case "issued_at":
            return ["issued_on"];
        case "month":
            return ["period"];
        case "invoice_count":
            return ["invoice_total_count"];
        case "currency":
            return ["currency_code"];
        case "commodity_id":
            return ["commodity_code_id"];
        case "commodity_code_id":
            return ["commodity_id"];
        case "quantity":
            return ["qty"];
        case "qty":
            return ["quantity"];
        default:
            return [];
    }
}

function mergeFieldValidations(
    existing: FieldValidation[],
    additional: FieldValidation[]
): FieldValidation[] {
    const merged = new Map<string, FieldValidation>();

    for (const validation of existing) {
        merged.set(validation.field, validation);
    }

    for (const validation of additional) {
        const current = merged.get(validation.field);
        if (!current || current.passed !== validation.passed) {
            merged.set(validation.field, validation);
        }
    }

    return [...merged.values()];
}
