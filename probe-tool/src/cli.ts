import * as fs from "fs";
import * as path from "path";
import { parseGoals } from "./goalParser";
import { probeGoal } from "./probeOrchestrator";
import { validateGoal } from "./validationEngine";
import { loadDocFile, buildContextString } from "./knowledgeContext";
import type {
    GoalInput,
    AttemptTrace,
    GoalValidationReport,
    ProbeSession,
} from "./types";

function randomId(): string {
    return Math.random().toString(36).slice(2, 10);
}

function loadEnv(): void {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key && !(key in process.env)) {
            process.env[key] = value;
        }
    }
}

function printSection(title: string): void {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${title}`);
    console.log("─".repeat(60));
}

function printReport(report: GoalValidationReport): void {
    const icon =
        report.status === "success" ? "✅" : report.status === "partial" ? "⚠️" : "❌";
    console.log(`\n${icon}  Goal: ${report.rawGoal}`);
    console.log(`   Status: ${report.status.toUpperCase()}`);
    console.log(`   ${report.summary}`);

    if (report.fieldValidations.length > 0) {
        console.log("   Field checks:");
        for (const fv of report.fieldValidations) {
            const mark = fv.passed ? "  ✓" : "  ✗";
            console.log(
                `${mark} ${fv.field}: expected=${JSON.stringify(fv.expected)}, actual=${JSON.stringify(fv.actual)}${fv.note ? " — " + fv.note : ""}`
            );
        }
    }

    if (report.failedSteps.length > 0) {
        console.log(`   Failed steps: ${report.failedSteps.join(", ")}`);
    }
}

async function run(): Promise<void> {
    loadEnv();

    // ── Resolve CLI args ─────────────────────────────────────────────────────
    const args = process.argv.slice(2);
    const configArg = args.find((a) => a.startsWith("--config="));

    if (!configArg) {
        console.error(
            "Usage: npm run probe -- --config=<path-to-probe-config.json>\n" +
            "\n" +
            "Required config fields:\n" +
            "  goals          string[]  – list of natural-language goals\n" +
            "  apiBaseUrl     string    – base URL of the target API\n" +
            "  authHeader     object    – headers to add to every request\n" +
            "  apiVersion     string    – version string passed to the LLM\n" +
            "  customerId     string    – customer/tenant identifier\n" +
            "  docPath        string    – path to human-readable API documentation file\n" +
            "  openApiPath    string?   – optional path to OpenAPI YAML/JSON file\n"
        );
        process.exit(1);
    }

    const configPath = configArg.replace("--config=", "");
    const configRaw = fs.readFileSync(path.resolve(configPath), "utf-8");
    const config = JSON.parse(configRaw) as {
        goals: string[];
        apiBaseUrl: string;
        authHeader: Record<string, string>;
        apiVersion: string;
        customerId: string;
        docPath: string;
        openApiPath?: string;
    };

    // ── Load documentation ───────────────────────────────────────────────────
    const baseDir = path.dirname(path.resolve(configPath));
    const humanDoc = loadDocFile(path.resolve(baseDir, config.docPath));
    const openApiDoc = config.openApiPath
        ? loadDocFile(path.resolve(baseDir, config.openApiPath))
        : undefined;

    const apiDocumentation = buildContextString(humanDoc, openApiDoc);

    const input: GoalInput = {
        goals: config.goals,
        apiBaseUrl: config.apiBaseUrl,
        authHeader: config.authHeader,
        apiVersion: config.apiVersion,
        customerId: config.customerId,
        apiDocumentation,
    };

    const sessionId = `session_${randomId()}`;
    const startedAt = new Date().toISOString();

    printSection(`API Probe Session: ${sessionId}`);
    console.log(`  Started:     ${startedAt}`);
    console.log(`  API:         ${input.apiBaseUrl} (version ${input.apiVersion})`);
    console.log(`  Customer:    ${input.customerId}`);
    console.log(`  Goals:       ${input.goals.length}`);

    // ── Parse goals ──────────────────────────────────────────────────────────
    printSection("Step 1 – Parsing goals with LLM");
    const parsedGoals = await parseGoals(input);
    for (const g of parsedGoals) {
        console.log(
            `  ${g.id}: [${g.accessLevel}] ${g.rawGoal} (write-validate: ${g.requiresWriteValidation})`
        );
    }

    // ── Probe each goal ──────────────────────────────────────────────────────
    printSection("Step 2 – Probing goals");
    const allAttempts: AttemptTrace[] = [];

    for (const goal of parsedGoals) {
        console.log(`\n▸ Probing: ${goal.rawGoal}`);
        const attempts = await probeGoal(goal, input);
        allAttempts.push(...attempts);
    }

    // ── Validate each goal ───────────────────────────────────────────────────
    printSection("Step 3 – Validating goal outcomes");
    const reports: GoalValidationReport[] = [];

    for (const goal of parsedGoals) {
        console.log(`\n▸ Validating: ${goal.rawGoal}`);
        const goalAttempts = allAttempts.filter((a) => a.goalId === goal.id);
        const report = await validateGoal(goal, goalAttempts);
        reports.push(report);
        printReport(report);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    printSection("Session Summary");
    const succeeded = reports.filter((r) => r.status === "success").length;
    const partial = reports.filter((r) => r.status === "partial").length;
    const failed = reports.filter((r) => r.status === "failed").length;
    const overallSuccess = failed === 0 && partial === 0;

    console.log(`  Goals succeeded: ${succeeded} / ${reports.length}`);
    if (partial > 0) console.log(`  Goals partial:   ${partial}`);
    if (failed > 0) console.log(`  Goals failed:    ${failed}`);
    console.log(`  Overall:         ${overallSuccess ? "SUCCESS ✅" : "NEEDS REVIEW ⚠️"}`);

    const finishedAt = new Date().toISOString();

    // ── Persist session to disk ───────────────────────────────────────────────
    const summaryLines: string[] = [
        `Session ${sessionId}: ${succeeded}/${reports.length} goals succeeded.`,
        ...reports.map((r) => `[${r.status}] ${r.rawGoal}: ${r.summary}`),
    ];

    const session: ProbeSession = {
        sessionId,
        startedAt,
        finishedAt,
        input: { ...input, apiDocumentation: "(omitted from saved session)" },
        parsedGoals,
        allAttempts,
        validationReports: reports,
        overallSuccess,
        summaryText: summaryLines.join("\n"),
    };

    const outPath = path.resolve(
        process.cwd(),
        `probe-results-${sessionId}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(session, null, 2), "utf-8");
    console.log(`\n  Full results saved to: ${outPath}`);
}

run().catch((err) => {
    console.error("\nProbe session failed with error:", err);
    process.exit(1);
});
