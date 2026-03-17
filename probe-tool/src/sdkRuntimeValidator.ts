import * as fs from "fs";
import * as path from "path";
import type { ProbeSession } from "./types";

type SdkProfile = {
    profileId: string;
    customerId: string;
    apiVersion: string;
    apiBaseUrl: string;
    capabilities: Array<{
        capabilityId: string;
        method: string;
        path: string;
    }>;
};

type ReplayCase = {
    capabilityId: string;
    method: string;
    requestPath: string;
    requestHeaders: Record<string, string>;
    requestBody: unknown;
    expectedStatus: number;
};

type ProfileReplay = {
    profileId: string;
    customerId: string;
    apiVersion: string;
    apiBaseUrl: string;
    casesByCapabilityId: Map<string, ReplayCase[]>;
};

function toProfileId(customerId: string, apiVersion: string, apiBaseUrl: string): string {
    return `${customerId}__${apiVersion}__${apiBaseUrl}`;
}

function toPathWithQuery(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
}

async function loadGeneratedSdk(): Promise<any> {
    const sdkPath = path.resolve(process.cwd(), "generated-sdk", "index.ts");
    try {
        return await import(sdkPath);
    } catch (error) {
        throw new Error(
            `Failed to load generated SDK from ${sdkPath}. Ensure harness generated it first. ${String(error)}`
        );
    }
}

function loadSessions(): ProbeSession[] {
    const cwd = process.cwd();
    const files = fs
        .readdirSync(cwd)
        .filter((name) => /^probe-results-session_.*\.json$/.test(name))
        .map((name) => path.join(cwd, name));

    const sessions: ProbeSession[] = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(file, "utf-8");
            sessions.push(JSON.parse(raw) as ProbeSession);
        } catch {
            // Ignore malformed session artifacts.
        }
    }

    sessions.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
    return sessions;
}

function buildReplayData(sessions: ProbeSession[]): Map<string, ProfileReplay> {
    const replayByProfile = new Map<string, ProfileReplay>();

    for (const session of sessions) {
        const profileId = toProfileId(
            session.input.customerId,
            session.input.apiVersion,
            session.input.apiBaseUrl
        );

        if (!replayByProfile.has(profileId)) {
            replayByProfile.set(profileId, {
                profileId,
                customerId: session.input.customerId,
                apiVersion: session.input.apiVersion,
                apiBaseUrl: session.input.apiBaseUrl,
                casesByCapabilityId: new Map<string, ReplayCase[]>(),
            });
        }

        const profileReplay = replayByProfile.get(profileId)!;

        for (const attempt of session.allAttempts) {
            if (!attempt.succeeded) {
                continue;
            }

            for (const stepTrace of attempt.stepTraces) {
                if (!stepTrace.success) {
                    continue;
                }

                const step = attempt.plan.steps.find((candidate) => candidate.stepId === stepTrace.stepId);
                if (!step || step.isValidationStep) {
                    continue;
                }

                const capabilityId = `${attempt.goalId}_${stepTrace.stepId}`;
                const existing = profileReplay.casesByCapabilityId.get(capabilityId) ?? [];
                existing.push({
                    capabilityId,
                    method: stepTrace.request.method,
                    requestPath: toPathWithQuery(stepTrace.request.url),
                    requestHeaders: { ...stepTrace.request.headers },
                    requestBody: stepTrace.request.body,
                    expectedStatus: stepTrace.response.status,
                });
                profileReplay.casesByCapabilityId.set(capabilityId, existing);
            }
        }
    }

    return replayByProfile;
}

function keepSdkRelevantHeaders(headers: Record<string, string>): Record<string, string> {
    return { ...headers };
}

function pathTemplatePrefix(pathTemplate: string): string {
    const tokenIndex = pathTemplate.indexOf("{{");
    if (tokenIndex < 0) {
        return pathTemplate;
    }
    return pathTemplate.slice(0, tokenIndex);
}

function selectReplayCase(candidates: ReplayCase[] | undefined, method: string, pathTemplate: string): ReplayCase | undefined {
    if (!candidates || candidates.length === 0) {
        return undefined;
    }

    const prefix = pathTemplatePrefix(pathTemplate);
    return candidates.find(
        (candidate) =>
            candidate.method.toUpperCase() === method.toUpperCase() &&
            candidate.requestPath.startsWith(prefix)
    ) ?? candidates[0];
}

export async function validateGeneratedSdk(): Promise<void> {
    console.log("\n[SDK Validator] Loading generated SDK...");
    const sdkModule = await loadGeneratedSdk();

    if (typeof sdkModule.createProbeSdk !== "function") {
        throw new Error("Generated SDK is missing createProbeSdk().");
    }

    const sdk = sdkModule.createProbeSdk();
    const sdkProfiles = sdk.listProfiles() as SdkProfile[];

    if (!Array.isArray(sdkProfiles) || sdkProfiles.length === 0) {
        throw new Error("Generated SDK has no profiles to validate.");
    }

    const sessions = loadSessions();
    const replayByProfile = buildReplayData(sessions);

    let totalPassed = 0;
    let totalFailed = 0;

    console.log(`[SDK Validator] Profiles to validate: ${sdkProfiles.length}`);

    for (const profile of sdkProfiles) {
        console.log(`[SDK Validator] Testing profile: ${profile.profileId}`);

        const profileReplay = replayByProfile.get(profile.profileId);
        if (!profileReplay) {
            totalFailed += profile.capabilities.length;
            console.log("  FAIL - No successful probe session found for this profile.");
            continue;
        }

        const client = sdk.forInstallation({
            customerId: profile.customerId,
            apiVersion: profile.apiVersion,
            apiBaseUrl: profile.apiBaseUrl,
            authHeader: {
                "x-api-key": process.env.LEGACY_API_KEY ?? "legacy-test-key",
            },
        });

        let profilePassed = 0;
        let profileFailed = 0;

        for (const capability of profile.capabilities) {
            const replayCase = selectReplayCase(
                profileReplay.casesByCapabilityId.get(capability.capabilityId),
                capability.method,
                capability.path
            );
            if (!replayCase) {
                profileFailed++;
                totalFailed++;
                console.log(`    FAIL ${capability.capabilityId} - missing replay case from successful traces`);
                continue;
            }

            try {
                await client.call(capability.capabilityId, {
                    path: replayCase.requestPath,
                    headers: keepSdkRelevantHeaders(replayCase.requestHeaders),
                    body: replayCase.requestBody ?? undefined,
                });

                if (replayCase.expectedStatus < 200 || replayCase.expectedStatus > 299) {
                    profileFailed++;
                    totalFailed++;
                    console.log(
                        `    FAIL ${capability.capabilityId} - expected non-2xx ${replayCase.expectedStatus}, but SDK call returned success`
                    );
                } else {
                    profilePassed++;
                    totalPassed++;
                }
            } catch (error) {
                profileFailed++;
                totalFailed++;
                console.log(`    FAIL ${capability.capabilityId} - ${String(error)}`);
            }
        }

        const status = profileFailed === 0 ? "PASS" : "PARTIAL";
        console.log(`  ${status} - passed ${profilePassed}, failed ${profileFailed}`);
    }

    console.log("\n[SDK Validator] Summary");
    console.log(`  Total passed: ${totalPassed}`);
    console.log(`  Total failed: ${totalFailed}`);

    if (totalFailed > 0) {
        throw new Error(`SDK validation failed: ${totalFailed} capability replay check(s) failed.`);
    }

    console.log("[SDK Validator] All replay-based SDK checks passed.");
}

