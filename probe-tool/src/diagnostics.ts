import type { AttemptDiagnostic, AttemptTrace, StepTrace } from "./types";

function failedStep(attempt: AttemptTrace): StepTrace | undefined {
    return attempt.stepTraces.find((step) => !step.success);
}

function lowerText(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

export function inferAttemptDiagnostics(attempt: AttemptTrace): AttemptDiagnostic[] {
    if (attempt.succeeded) {
        return [];
    }

    const failed = failedStep(attempt);
    if (!failed) {
        return [
            {
                code: "UNKNOWN_FAILURE",
                severity: "medium",
                message: attempt.failureReason ?? "Attempt failed with no failed step trace.",
            },
        ];
    }

    const status = failed.response.status;
    const errorText = lowerText(failed.error) + " " + lowerText(JSON.stringify(failed.response.body));
    const diagnostics: AttemptDiagnostic[] = [];

    if (errorText.includes("network error")) {
        diagnostics.push({
            code: "NETWORK_FAILURE",
            severity: "high",
            stepId: failed.stepId,
            message: failed.error ?? "Network error during request execution.",
            suggestion: "Retry request and verify API availability.",
        });
    }

    if (status === 405 || (status === 404 && failed.request.method !== "GET")) {
        diagnostics.push({
            code: "METHOD_MISMATCH",
            severity: "high",
            stepId: failed.stepId,
            message: `Method ${failed.request.method} may be incorrect for ${failed.request.url}.`,
            suggestion: "Try method alternatives such as POST/PUT/PATCH.",
        });
    }

    if (status === 401 || status === 403) {
        diagnostics.push({
            code: "AUTH_MISMATCH",
            severity: "high",
            stepId: failed.stepId,
            message: "Request was rejected by authentication/authorization.",
            suggestion: "Verify auth header names/values and required supplementary headers.",
        });
    }

    if (
        status === 400 &&
        (errorText.includes("required") || errorText.includes("missing") || errorText.includes("invalid"))
    ) {
        diagnostics.push({
            code: "PARAMETER_MISMATCH",
            severity: "high",
            stepId: failed.stepId,
            message: "Request payload or query parameters likely do not match API expectations.",
            suggestion: "Try alternate field names from older/newer versions and inspect error body hints.",
        });
    }

    if (
        status === 400 &&
        (errorText.includes("template") || errorText.includes("token") || errorText.includes("preflight"))
    ) {
        diagnostics.push({
            code: "MISSING_PREREQUISITE_STEP",
            severity: "high",
            stepId: failed.stepId,
            message: "API likely requires an undocumented setup step before this call.",
            suggestion: "Discover prerequisite endpoint to fetch token/template and retry with extracted value.",
        });
    }

    if (status === 404 && failed.request.method === "GET") {
        diagnostics.push({
            code: "RESOURCE_NOT_FOUND",
            severity: "medium",
            stepId: failed.stepId,
            message: "Resource path may be wrong or identifier was not created successfully.",
            suggestion: "Verify endpoint path and upstream write step assumptions.",
        });
    }

    if (diagnostics.length === 0) {
        diagnostics.push({
            code: "UNKNOWN_FAILURE",
            severity: "medium",
            stepId: failed.stepId,
            message: failed.error ?? `Unhandled failure with HTTP status ${status}.`,
            suggestion: "Review full step trace and retry with alternate method/field hypotheses.",
        });
    }

    return diagnostics;
}

export function diagnosticsPromptSummary(diagnostics: AttemptDiagnostic[]): string {
    if (diagnostics.length === 0) {
        return "No diagnostics available.";
    }

    return diagnostics
        .map((d, i) => {
            const parts = [
                `${i + 1}. [${d.code}]`,
                d.message,
                d.suggestion ? `Suggestion: ${d.suggestion}` : "",
            ].filter(Boolean);
            return parts.join(" ");
        })
        .join("\n");
}
