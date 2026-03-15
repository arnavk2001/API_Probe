import type {
    AttemptDiagnostic,
    AttemptTrace,
    CapabilityProfile,
    CapabilitySignature,
    GoalInput,
    GoalValidationReport,
    ParsedGoal,
} from "./types";

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function requiredBodyFieldsFromStep(stepBody: unknown): string[] {
    if (!stepBody || typeof stepBody !== "object" || Array.isArray(stepBody)) {
        return [];
    }
    return uniqueSorted(Object.keys(stepBody as Record<string, unknown>));
}

function requiredQueryParamsFromStep(stepQuery: Record<string, string> | undefined): string[] {
    if (!stepQuery) {
        return [];
    }
    return uniqueSorted(Object.keys(stepQuery));
}

function requiredHeadersFromStep(headers: Record<string, string> | undefined): string[] {
    if (!headers) {
        return [];
    }
    return uniqueSorted(Object.keys(headers));
}

function prerequisitesForAttempt(attempt: AttemptTrace): string[] {
    const prereqPaths = attempt.plan.steps
        .filter((step) => step.extractVariables && Object.keys(step.extractVariables).length > 0)
        .map((step) => step.path);
    return uniqueSorted(prereqPaths);
}

function confidenceForAttempt(
    attempt: AttemptTrace,
    report: GoalValidationReport | undefined
): number {
    if (!attempt.succeeded) {
        return 0.1;
    }

    const base = report?.status === "success" ? 0.95 : report?.status === "partial" ? 0.7 : 0.5;
    const penalty = Math.min(attempt.attemptIndex * 0.05, 0.25);
    return Math.max(0.1, Math.min(0.99, base - penalty));
}

function buildCapabilityForGoal(
    goal: ParsedGoal,
    successfulAttempt: AttemptTrace,
    report: GoalValidationReport | undefined
): CapabilitySignature[] {
    const capabilities: CapabilitySignature[] = [];

    successfulAttempt.plan.steps.forEach((step, index) => {
        if (step.isValidationStep) {
            return;
        }

        const stepTrace = successfulAttempt.stepTraces.find((trace) => trace.stepId === step.stepId);
        const successStatus = stepTrace ? [stepTrace.response.status] : [];

        capabilities.push({
            capabilityId: `${goal.id}_${step.stepId}`,
            goalId: goal.id,
            goalText: goal.rawGoal,
            method: step.method,
            path: step.path,
            successStatusCodes: successStatus,
            requiredHeaders: requiredHeadersFromStep(step.headers),
            requiredQueryParams: requiredQueryParamsFromStep(step.query),
            requiredBodyFields: requiredBodyFieldsFromStep(step.body),
            prerequisitePaths:
                index > 0 ? prerequisitesForAttempt(successfulAttempt) : [],
            confidence: confidenceForAttempt(successfulAttempt, report),
        });
    });

    return capabilities;
}

export function buildCapabilityProfile(
    input: GoalInput,
    parsedGoals: ParsedGoal[],
    attempts: AttemptTrace[],
    reports: GoalValidationReport[],
    diagnostics: AttemptDiagnostic[]
): CapabilityProfile {
    const now = new Date().toISOString();
    const capabilities: CapabilitySignature[] = [];

    for (const goal of parsedGoals) {
        const goalAttempts = attempts.filter((attempt) => attempt.goalId === goal.id);
        const successfulAttempt = [...goalAttempts].reverse().find((attempt) => attempt.succeeded);
        if (!successfulAttempt) {
            continue;
        }

        const report = reports.find((item) => item.goalId === goal.id);
        capabilities.push(...buildCapabilityForGoal(goal, successfulAttempt, report));
    }

    return {
        profileId: `${input.customerId}__${input.apiVersion}__${input.apiBaseUrl}`,
        createdAt: now,
        updatedAt: now,
        apiBaseUrl: input.apiBaseUrl,
        apiVersion: input.apiVersion,
        customerId: input.customerId,
        capabilities,
        recentDiagnostics: diagnostics.slice(0, 30),
    };
}
