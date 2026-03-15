// ─── Input ────────────────────────────────────────────────────────────────────

export type GoalInput = {
    /** Natural-language goals, e.g. ["Create an order and read it back"] */
    goals: string[];
    /** Base URL of the target API, e.g. "http://localhost:4011" */
    apiBaseUrl: string;
    /** Auth headers to include on every request, e.g. {"x-api-key": "secret"} */
    authHeader: Record<string, string>;
    /** API version string passed to the LLM for context, e.g. "v1.1" */
    apiVersion: string;
    /** Customer/tenant identifier used as a default substitution variable */
    customerId: string;
    /** Full documentation text (human-readable + optional OpenAPI). Loaded before the session. */
    apiDocumentation: string;
};

// ─── Parsed Goals ─────────────────────────────────────────────────────────────

export type AccessLevel = "read-only" | "write" | "read-write";

export type ParsedGoal = {
    id: string;
    rawGoal: string;
    requiredOperations: string[];
    accessLevel: AccessLevel;
    entities: string[];
    successCriteria: string[];
    /** True when the goal writes data and must be followed by a read-back check. */
    requiresWriteValidation: boolean;
};

// ─── Workflow Plan ────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type WorkflowStep = {
    stepId: string;
    description: string;
    method: HttpMethod;
    /**
     * Path relative to baseUrl – may include {{varName}} substitution tokens.
     * Must start with "/".
     */
    path: string;
    /** Query-string parameters. Values may contain {{varName}} tokens. */
    query?: Record<string, string>;
    /** Additional request headers beyond the global auth headers. */
    headers?: Record<string, string>;
    /**
     * Request body (for POST/PUT/PATCH).
     * Any string value may contain {{varName}} tokens.
     * A string that IS a token (e.g. "{{orderId}}") receives the raw extracted value
     * to preserve number/boolean types.
     */
    body?: unknown;
    /**
     * Map of variable-name → dot-path into the JSON response body.
     * Extracted values are injected into the shared variable context for subsequent steps.
     * Example: { "templateToken": "template_token" }
     */
    extractVariables?: Record<string, string>;
    /** Mark true if this step is a pure read-back validation step rather than a mutating call. */
    isValidationStep?: boolean;
};

export type WorkflowPlan = {
    goalId: string;
    /**
     * LLM reasoning about WHY this approach was chosen and what alternatives were considered.
     * Stored in traces for debugging and future context.
     */
    reasoning: string;
    steps: WorkflowStep[];
    /** Hint about what to try differently if this plan fails. Passed back to the LLM on retry. */
    fallbackNote?: string;
};

// ─── Execution Traces ─────────────────────────────────────────────────────────

export type StepTrace = {
    stepId: string;
    request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: unknown;
    };
    response: {
        status: number;
        body: unknown;
        headers: Record<string, string>;
    };
    durationMs: number;
    extractedVariables: Record<string, unknown>;
    success: boolean;
    /** Human-readable failure description if success === false */
    error?: string;
};

export type AttemptTrace = {
    goalId: string;
    /** Zero-indexed attempt counter for this goal */
    attemptIndex: number;
    plan: WorkflowPlan;
    stepTraces: StepTrace[];
    succeeded: boolean;
    failedAtStep?: string;
    failureReason?: string;
    diagnostics?: AttemptDiagnostic[];
};

// ─── Validation ───────────────────────────────────────────────────────────────

export type FieldValidation = {
    field: string;
    expected: unknown;
    actual: unknown;
    passed: boolean;
    note?: string;
};

export type GoalValidationReport = {
    goalId: string;
    rawGoal: string;
    status: "success" | "partial" | "failed";
    fieldValidations: FieldValidation[];
    summary: string;
    successfulSteps: string[];
    failedSteps: string[];
};

// ─── Session ──────────────────────────────────────────────────────────────────

export type ProbeSession = {
    sessionId: string;
    startedAt: string;
    finishedAt: string;
    input: GoalInput;
    parsedGoals: ParsedGoal[];
    allAttempts: AttemptTrace[];
    validationReports: GoalValidationReport[];
    capabilityProfile?: CapabilityProfile;
    driftReport?: DriftReport;
    generatedSdkPath?: string;
    overallSuccess: boolean;
    summaryText: string;
};

// ─── Phase 2 Discovery / Drift ───────────────────────────────────────────────

export type DiagnosticCode =
    | "METHOD_MISMATCH"
    | "PARAMETER_MISMATCH"
    | "AUTH_MISMATCH"
    | "MISSING_PREREQUISITE_STEP"
    | "RESOURCE_NOT_FOUND"
    | "NETWORK_FAILURE"
    | "VALIDATION_MISMATCH"
    | "UNKNOWN_FAILURE";

export type AttemptDiagnostic = {
    code: DiagnosticCode;
    severity: "low" | "medium" | "high";
    stepId?: string;
    message: string;
    suggestion?: string;
};

export type CapabilitySignature = {
    capabilityId: string;
    goalId: string;
    goalText: string;
    method: HttpMethod;
    path: string;
    successStatusCodes: number[];
    requiredHeaders: string[];
    requiredQueryParams: string[];
    requiredBodyFields: string[];
    prerequisitePaths: string[];
    confidence: number;
};

export type CapabilityProfile = {
    profileId: string;
    createdAt: string;
    updatedAt: string;
    apiBaseUrl: string;
    apiVersion: string;
    customerId: string;
    capabilities: CapabilitySignature[];
    recentDiagnostics: AttemptDiagnostic[];
};

export type DriftChangeType = "added" | "removed" | "modified";
export type DriftSeverity = "compatible" | "warning" | "breaking";

export type DriftChange = {
    capabilityId: string;
    type: DriftChangeType;
    severity: DriftSeverity;
    message: string;
};

export type DriftReport = {
    profileId: string;
    generatedAt: string;
    hasChanges: boolean;
    summary: string;
    changes: DriftChange[];
};
