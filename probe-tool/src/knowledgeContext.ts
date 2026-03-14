import * as fs from "fs";
import * as path from "path";

/**
 * Reads a documentation file from disk.
 * @param docPath Absolute or cwd-relative path to the file.
 */
export function loadDocFile(docPath: string): string {
    const resolved = path.resolve(docPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Documentation file not found: ${resolved}`);
    }
    return fs.readFileSync(resolved, "utf-8");
}

/**
 * Combines human-readable and OpenAPI documentation into a single context string
 * that is given to the LLM as background knowledge.
 */
export function buildContextString(
    humanReadableDoc: string,
    openApiSpec?: string
): string {
    const parts: string[] = [
        "=== API DOCUMENTATION (Human-Readable) ===\n" + humanReadableDoc,
    ];

    if (openApiSpec) {
        parts.push("=== OPENAPI SPECIFICATION ===\n" + openApiSpec);
    }

    return parts.join("\n\n");
}
