import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_JSON_RETRIES = 3;

let _genAI: GoogleGenerativeAI | null = null;

function getModel(): GenerativeModel {
    if (!_genAI) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error(
                "GEMINI_API_KEY environment variable is not set. " +
                "Copy probe-tool/.env.example to probe-tool/.env and fill in your key."
            );
        }
        _genAI = new GoogleGenerativeAI(apiKey);
    }
    return _genAI.getGenerativeModel({ model: resolvedModel() });
}

function resolvedModel(): string {
    return process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

function maxJsonRetries(): number {
    const raw = process.env.LLM_JSON_RETRIES;
    const parsed = raw ? parseInt(raw, 10) : DEFAULT_JSON_RETRIES;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JSON_RETRIES;
}

/** Raw LLM completion – returns the full text response. */
export async function llmComplete(
    systemPrompt: string,
    userMessage: string
): Promise<string> {
    const model = getModel();
    const result = await model.generateContent({
        systemInstruction: systemPrompt,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
    });

    const text = result.response.text();
    if (!text) {
        throw new Error("Gemini returned no text content in response.");
    }
    return text;
}

/**
 * LLM completion that parses the response as JSON.
 * Strips markdown code fences if present.
 * Retries the LLM call up to LLM_JSON_RETRIES times on parse failure.
 */
export async function llmCompleteJSON<T>(
    systemPrompt: string,
    userMessage: string
): Promise<T> {
    let lastError: Error | null = null;
    const retries = maxJsonRetries();

    for (let attempt = 0; attempt < retries; attempt++) {
        const repairHint =
            lastError && attempt > 0
                ? `\n\nIMPORTANT: Your previous response could not be parsed as JSON. Error: "${lastError.message}". Return ONLY raw JSON with no markdown, no explanation, and no code fences.`
                : "";

        const text = await llmComplete(systemPrompt, userMessage + repairHint);

        try {
            return parseJson<T>(text);
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < retries - 1) {
                // give the model context about the failure on the next attempt
                continue;
            }
        }
    }

    throw new Error(
        `LLM returned invalid JSON after ${retries} attempts. Last error: ${lastError?.message}`
    );
}

function parseJson<T>(text: string): T {
    // Strip optional markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();

    // First try the stripped version, then fall back to scanning for the first
    // JSON object or array anywhere in the text (handles prose + JSON responses).
    try {
        return JSON.parse(stripped) as T;
    } catch {
        const match = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (match) {
            return JSON.parse(match[1]) as T;
        }
        throw new Error(
            `No valid JSON found in response: "${text.slice(0, 200)}…"`
        );
    }
}
