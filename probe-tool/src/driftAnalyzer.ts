import type {
    CapabilityProfile,
    CapabilitySignature,
    DriftChange,
    DriftReport,
    DriftSeverity,
} from "./types";

function byId(capabilities: CapabilitySignature[]): Map<string, CapabilitySignature> {
    return new Map(capabilities.map((cap) => [cap.capabilityId, cap]));
}

function severityForModified(before: CapabilitySignature, after: CapabilitySignature): DriftSeverity {
    if (before.method !== after.method || before.path !== after.path) {
        return "breaking";
    }

    const addedRequiredFields = after.requiredBodyFields.filter(
        (field) => !before.requiredBodyFields.includes(field)
    );
    if (addedRequiredFields.length > 0) {
        return "warning";
    }

    return "compatible";
}

export function analyzeDrift(
    previous: CapabilityProfile | null,
    current: CapabilityProfile
): DriftReport {
    if (!previous) {
        return {
            profileId: current.profileId,
            generatedAt: new Date().toISOString(),
            hasChanges: true,
            summary: "No prior profile found. Baseline profile created.",
            changes: current.capabilities.map((cap) => ({
                capabilityId: cap.capabilityId,
                type: "added",
                severity: "compatible",
                message: `New baseline capability discovered: ${cap.method} ${cap.path}`,
            })),
        };
    }

    const oldMap = byId(previous.capabilities);
    const newMap = byId(current.capabilities);
    const changes: DriftChange[] = [];

    for (const [id, currentCap] of newMap.entries()) {
        const oldCap = oldMap.get(id);
        if (!oldCap) {
            changes.push({
                capabilityId: id,
                type: "added",
                severity: "warning",
                message: `Capability added: ${currentCap.method} ${currentCap.path}`,
            });
            continue;
        }

        if (
            oldCap.method !== currentCap.method ||
            oldCap.path !== currentCap.path ||
            JSON.stringify(oldCap.requiredBodyFields) !== JSON.stringify(currentCap.requiredBodyFields) ||
            JSON.stringify(oldCap.requiredQueryParams) !== JSON.stringify(currentCap.requiredQueryParams) ||
            JSON.stringify(oldCap.prerequisitePaths) !== JSON.stringify(currentCap.prerequisitePaths)
        ) {
            changes.push({
                capabilityId: id,
                type: "modified",
                severity: severityForModified(oldCap, currentCap),
                message: `Capability changed from ${oldCap.method} ${oldCap.path} to ${currentCap.method} ${currentCap.path}`,
            });
        }
    }

    for (const [id, oldCap] of oldMap.entries()) {
        if (!newMap.has(id)) {
            changes.push({
                capabilityId: id,
                type: "removed",
                severity: "breaking",
                message: `Capability removed: ${oldCap.method} ${oldCap.path}`,
            });
        }
    }

    const breakingCount = changes.filter((change) => change.severity === "breaking").length;
    const warningCount = changes.filter((change) => change.severity === "warning").length;

    let summary = "No profile drift detected.";
    if (changes.length > 0) {
        summary = `Detected ${changes.length} drift change(s): ${breakingCount} breaking, ${warningCount} warning.`;
    }

    return {
        profileId: current.profileId,
        generatedAt: new Date().toISOString(),
        hasChanges: changes.length > 0,
        summary,
        changes,
    };
}
