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

    // Ensure IDs are populated in case the LLM omits them
    report.goalId = goal.id;
    report.rawGoal = goal.rawGoal;

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
