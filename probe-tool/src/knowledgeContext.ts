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

export async function loadDocUrls(urls: string[]): Promise<string[]> {
    const docs: string[] = [];
    for (const url of urls) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch documentation URL ${url}: HTTP ${response.status}`);
        }
        docs.push(await response.text());
    }
    return docs;
}

/**
 * Combines human-readable and OpenAPI documentation into a single context string
 * that is given to the LLM as background knowledge.
 */
export function buildContextString(
    humanReadableDoc: string | string[],
    openApiSpec?: string
): string {
    const humanDocParts = Array.isArray(humanReadableDoc)
        ? humanReadableDoc
        : [humanReadableDoc];

    const parts: string[] = [
        ...humanDocParts.map((doc, index) =>
            `=== API DOCUMENTATION (Human-Readable${humanDocParts.length > 1 ? ` #${index + 1}` : ""}) ===\n${doc}`
        ),
    ];

    if (openApiSpec) {
        parts.push("=== OPENAPI SPECIFICATION ===\n" + openApiSpec);
    }

    return parts.join("\n\n");
}
