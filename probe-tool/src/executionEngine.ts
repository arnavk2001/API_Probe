import type {
    WorkflowPlan,
    WorkflowStep,
    AttemptTrace,
    StepTrace,
} from "./types";

/**
 * Substitute {{varName}} tokens in a string value with matching context entries.
 * Leaves tokens intact if the variable is not found (rather than silently dropping them)
 * so downstream LLM reasoning can detect missing variables.
 */
function interpolate(template: string, ctx: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const val = ctx[key];
        return val !== undefined ? String(val) : `{{${key}}}`;
    });
}

/**
 * Recursively walk an arbitrary body value and interpolate all string tokens.
 * Non-string scalars and arrays are handled recursively.
 *
 * Special case: if a string value is EXACTLY "{{varName}}" (the whole string is
 * just a single token), the raw typed value from ctx is used directly so that
 * numbers / booleans are not coerced to strings.
 */
function interpolateBody(
    value: unknown,
    ctx: Record<string, unknown>
): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === "string") {
        const singleTokenMatch = value.match(/^\{\{(\w+)\}\}$/);
        if (singleTokenMatch) {
            const rawVal = ctx[singleTokenMatch[1]];
            return rawVal !== undefined ? rawVal : value;
        }
        return interpolate(value, ctx);
    }
    if (Array.isArray(value)) {
        return value.map((item) => interpolateBody(item, ctx));
    }
    if (typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            result[k] = interpolateBody(v, ctx);
        }
        return result;
    }
    return value;
}

/**
 * Traverse a JSON response body using a simple dot-path string.
 * Supports nested keys, e.g. "data.order.id".
 * Returns undefined if path is not found.
 */
function extractByPath(body: unknown, dotPath: string): unknown {
    const parts = dotPath.split(".");
    let cursor: unknown = body;

    for (const part of parts) {
        if (cursor === null || typeof cursor !== "object") {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[part];
    }

    return cursor;
}

/**
 * Execute a single step in a workflow plan.
 * Returns a StepTrace capturing the full request/response and any extracted variables.
 */
async function executeStep(
    step: WorkflowStep,
    baseUrl: string,
    authHeaders: Record<string, string>,
    variableContext: Record<string, unknown>
): Promise<{ trace: StepTrace; updatedContext: Record<string, unknown> }> {
    const startMs = Date.now();

    // Build the URL with interpolated path + query
    const interpolatedPath = interpolate(step.path, variableContext);
    const url = new URL(baseUrl + interpolatedPath);
    if (step.query) {
        for (const [k, v] of Object.entries(step.query)) {
            url.searchParams.set(k, interpolate(v, variableContext));
        }
    }

    // Merge headers
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...authHeaders,
    };
    if (step.headers) {
        for (const [k, v] of Object.entries(step.headers)) {
            headers[k] = interpolate(v, variableContext);
        }
    }

    // Prepare body
    const requestBody =
        step.body !== undefined && step.body !== null
            ? interpolateBody(step.body, variableContext)
            : undefined;

    const allowsRequestBody = step.method !== "GET" && step.method !== "DELETE";

    const fetchOptions: RequestInit = {
        method: step.method,
        headers,
        body:
            allowsRequestBody && requestBody !== undefined
                ? JSON.stringify(requestBody)
                : undefined,
    };

    const requestSnapshot = {
        method: step.method,
        url: url.toString(),
        headers,
        body: requestBody,
    };

    let responseStatus = 0;
    let responseBody: unknown = null;
    let responseHeaders: Record<string, string> = {};
    let success = false;
    let error: string | undefined;

    try {
        const response = await fetch(url.toString(), fetchOptions);
        responseStatus = response.status;

        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        const text = await response.text();
        try {
            responseBody = text ? JSON.parse(text) : null;
        } catch {
            responseBody = text;
        }

        success = response.ok;
        if (!success) {
            error = `HTTP ${responseStatus} – ${JSON.stringify(responseBody).slice(0, 200)}`;
        }
    } catch (fetchErr) {
        error = `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
    }

    // Extract variables from response body
    const extractedVariables: Record<string, unknown> = {};
    const updatedContext = { ...variableContext };

    if (success && step.extractVariables && typeof responseBody === "object" && responseBody !== null) {
        for (const [varName, dotPath] of Object.entries(step.extractVariables)) {
            const extracted = extractByPath(responseBody, dotPath);
            if (extracted !== undefined) {
                extractedVariables[varName] = extracted;
                updatedContext[varName] = extracted;
            }
        }
    }

    const durationMs = Date.now() - startMs;

    const trace: StepTrace = {
        stepId: step.stepId,
        request: requestSnapshot,
        response: {
            status: responseStatus,
            body: responseBody,
            headers: responseHeaders,
        },
        durationMs,
        extractedVariables,
        success,
        error,
    };

    return { trace, updatedContext };
}

/**
 * Execute an entire workflow plan step-by-step.
 * Stops on the first failed step and records the failure reason.
 */
export async function executePlan(
    plan: WorkflowPlan,
    baseUrl: string,
    authHeaders: Record<string, string>,
    initialContext: Record<string, unknown>
): Promise<AttemptTrace> {
    const stepTraces: StepTrace[] = [];
    let variableContext = { ...initialContext };

    let succeeded = true;
    let failedAtStep: string | undefined;
    let failureReason: string | undefined;

    for (const step of plan.steps) {
        const { trace, updatedContext } = await executeStep(
            step,
            baseUrl,
            authHeaders,
            variableContext
        );

        stepTraces.push(trace);
        variableContext = updatedContext;

        if (!trace.success) {
            succeeded = false;
            failedAtStep = step.stepId;
            failureReason = trace.error;
            // Stop executing further steps – we'll give the failure to the LLM to plan a fix.
            break;
        }
    }

    return {
        goalId: plan.goalId,
        attemptIndex: 0, // will be overwritten by caller
        plan,
        stepTraces,
        succeeded,
        failedAtStep,
        failureReason,
    };
}
