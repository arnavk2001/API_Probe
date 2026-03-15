import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import type { ProbeSession } from "./types";

const repoRoot = path.resolve(__dirname, "../..");
const probeRoot = path.resolve(__dirname, "..");

type Scenario = {
    name: string;
    configPath: string;
    maxAttempts: number;
    expectOverallSuccess: boolean;
    runRetries?: number;
};

function loadEnv(): void {
    const envPath = path.resolve(probeRoot, ".env");
    if (!fs.existsSync(envPath)) {
        return;
    }

    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const idx = trimmed.indexOf("=");
        if (idx < 0) {
            continue;
        }
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (key && !(key in process.env)) {
            process.env[key] = value;
        }
    }
}

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        proc.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });

        proc.on("close", (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}

async function healthOk(url: string): Promise<boolean> {
    try {
        const response = await fetch(url);
        return response.ok;
    } catch {
        return false;
    }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await healthOk(url)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
}

function startServerIfNeeded(
    healthUrl: string,
    command: string,
    args: string[]
): Promise<ChildProcess | null> {
    return new Promise(async (resolve, reject) => {
        if (await healthOk(healthUrl)) {
            resolve(null);
            return;
        }

        const proc = spawn(command, args, {
            cwd: repoRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let startupErrors = "";
        proc.stderr.on("data", (chunk) => {
            startupErrors += String(chunk);
        });

        const ready = await waitForHealth(healthUrl, 12000);
        if (!ready) {
            proc.kill("SIGTERM");
            reject(new Error(`Server did not become healthy: ${healthUrl}. ${startupErrors}`));
            return;
        }

        resolve(proc);
    });
}

function parseSessionPath(stdout: string): string {
    const match = stdout.match(/Full results saved to:\s*(.+)/);
    if (!match) {
        throw new Error("Could not find session output path in probe logs.");
    }
    return match[1].trim();
}

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function runScenario(scenario: Scenario): Promise<ProbeSession> {
    const retries = scenario.runRetries ?? 0;
    let lastSession: ProbeSession | null = null;
    let lastStdout = "";
    let lastStderr = "";

    for (let runIndex = 0; runIndex <= retries; runIndex++) {
        const result = await runCommand(
            "npm",
            ["run", "probe", "--", `--config=${scenario.configPath}`],
            probeRoot,
            { MAX_PROBE_ATTEMPTS: String(scenario.maxAttempts) }
        );

        lastStdout = result.stdout;
        lastStderr = result.stderr;

        if (result.code !== 0) {
            continue;
        }

        const sessionPath = parseSessionPath(result.stdout);
        const raw = fs.readFileSync(sessionPath, "utf-8");
        const session = JSON.parse(raw) as ProbeSession;
        lastSession = session;

        if (session.overallSuccess === scenario.expectOverallSuccess) {
            return session;
        }

        console.warn(
            `[Harness] Scenario ${scenario.name} run ${runIndex + 1}/${retries + 1} had overallSuccess=${session.overallSuccess}; retrying...`
        );
    }

    if (lastSession) {
        throw new Error(
            `Scenario ${scenario.name} expected overallSuccess=${scenario.expectOverallSuccess}, got ${lastSession.overallSuccess}. Summary: ${lastSession.summaryText}`
        );
    }

    throw new Error(
        `Scenario ${scenario.name} failed to produce a valid session output.\nSTDOUT:\n${lastStdout}\nSTDERR:\n${lastStderr}`
    );
}

function profilePath(baseUrl: string, customerId: string, apiVersion: string): string {
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(
        probeRoot,
        "profiles",
        `${safe(customerId)}__${safe(apiVersion)}__${safe(baseUrl)}.json`
    );
}

async function runHarness(): Promise<void> {
    loadEnv();

    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is required for Phase 3 harness.");
    }

    fs.rmSync(path.join(probeRoot, "profiles"), { recursive: true, force: true });
    fs.rmSync(path.join(probeRoot, "generated-sdk"), { recursive: true, force: true });

    const started: ChildProcess[] = [];
    try {
        const server1 = await startServerIfNeeded(
            "http://localhost:4011/health",
            "npm",
            ["run", "dev"]
        );
        if (server1) started.push(server1);

        const server2 = await startServerIfNeeded(
            "http://localhost:4012/health",
            "npm",
            ["run", "dev:server2"]
        );
        if (server2) started.push(server2);

        const server3 = await startServerIfNeeded(
            "http://localhost:4013/health",
            "npm",
            ["run", "dev:server3"]
        );
        if (server3) started.push(server3);

        const scenarios: Scenario[] = [
            {
                name: "cust_a_v11_server1",
                configPath: path.join(probeRoot, "configs", "cust_a_v11_server1.json"),
                maxAttempts: 3,
                expectOverallSuccess: true,
                runRetries: 1,
            },
            {
                name: "cust_a_v11_server2_drift",
                configPath: path.join(probeRoot, "configs", "cust_a_v11_server2.json"),
                maxAttempts: 3,
                expectOverallSuccess: true,
                runRetries: 2,
            },
            {
                name: "cust_a_v11_server3_xml_drift",
                configPath: path.join(probeRoot, "configs", "cust_a_v11_server3.json"),
                maxAttempts: 3,
                expectOverallSuccess: true,
                runRetries: 2,
            },
            {
                name: "cust_a_v12_server1_upgrade",
                configPath: path.join(probeRoot, "configs", "cust_a_v12_server1.json"),
                maxAttempts: 3,
                expectOverallSuccess: true,
                runRetries: 1,
            },
            {
                name: "cust_b_v11_server1",
                configPath: path.join(probeRoot, "configs", "cust_b_v11_server1.json"),
                maxAttempts: 3,
                expectOverallSuccess: true,
                runRetries: 1,
            },
        ];

        const sessions: ProbeSession[] = [];
        for (const scenario of scenarios) {
            console.log(`\n[Harness] Running scenario: ${scenario.name}`);
            const session = await runScenario(scenario);
            sessions.push(session);

            if (scenario.name.includes("server2") || scenario.name.includes("server3")) {
                for (const goal of session.parsedGoals) {
                    const firstAttempt = session.allAttempts.find(
                        (attempt) => attempt.goalId === goal.id && attempt.attemptIndex === 0
                    );
                    assert(
                        !!firstAttempt && !firstAttempt.succeeded,
                        `Expected first attempt to fail for ${scenario.name}/${goal.id} to prove undocumented drift.`
                    );
                }
            }
        }

        const sdkPath = path.join(probeRoot, "generated-sdk", "index.ts");
        assert(fs.existsSync(sdkPath), "Unified callable SDK was not generated.");

        const sdkText = fs.readFileSync(sdkPath, "utf-8");
        assert(
            sdkText.includes("createProbeSdk") && sdkText.includes("forInstallation"),
            "Unified SDK is missing callable entry points."
        );

        assert(
            fs.existsSync(profilePath("http://localhost:4011", "cust_a", "v1.1")),
            "Missing profile for customer A v1.1 server1"
        );
        assert(
            fs.existsSync(profilePath("http://localhost:4012", "cust_a", "v1.1")),
            "Missing profile for customer A v1.1 server2"
        );
        assert(
            fs.existsSync(profilePath("http://localhost:4013", "cust_a", "v1.1")),
            "Missing profile for customer A v1.1 server3"
        );
        assert(
            fs.existsSync(profilePath("http://localhost:4011", "cust_a", "v1.2")),
            "Missing profile for customer A v1.2 upgrade"
        );
        assert(
            fs.existsSync(profilePath("http://localhost:4011", "cust_b", "v1.1")),
            "Missing profile for customer B v1.1"
        );

        console.log("\n[Harness] Phase 3 validation succeeded.");
        console.log(`[Harness] Sessions executed: ${sessions.length}`);
        console.log(`[Harness] Unified SDK: ${sdkPath}`);
    } finally {
        for (const proc of started) {
            proc.kill("SIGTERM");
        }
    }
}

runHarness().catch((error) => {
    console.error("\n[Harness] Phase 3 validation failed:", error);
    process.exit(1);
});
