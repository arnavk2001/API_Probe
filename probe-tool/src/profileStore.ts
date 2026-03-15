import * as fs from "fs";
import * as path from "path";
import type { CapabilityProfile } from "./types";

const PROFILE_DIR = path.resolve(process.cwd(), "profiles");

function safe(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function profilePath(customerId: string, apiVersion: string, apiBaseUrl: string): string {
    return path.join(
        PROFILE_DIR,
        `${safe(customerId)}__${safe(apiVersion)}__${safe(apiBaseUrl)}.json`
    );
}

export function loadExistingProfile(
    customerId: string,
    apiVersion: string,
    apiBaseUrl: string
): CapabilityProfile | null {
    const filePath = profilePath(customerId, apiVersion, apiBaseUrl);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CapabilityProfile;
}

export function saveProfile(profile: CapabilityProfile): string {
    if (!fs.existsSync(PROFILE_DIR)) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    const filePath = profilePath(
        profile.customerId,
        profile.apiVersion,
        profile.apiBaseUrl
    );
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
    return filePath;
}
