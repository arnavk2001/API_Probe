import { llmCompleteJSON } from "./llmClient";
import type { GoalInput, ParsedGoal } from "./types";

const SYSTEM_PROMPT = `You are an API integration expert. Given a set of natural language goals and the documentation of a legacy API, parse each goal into a structured JSON object.

Return a JSON ARRAY of parsed goals. Each element must match this shape exactly:
{
  "id": "goal_1",
  "rawGoal": "the original goal string verbatim",
  "requiredOperations": ["short description of each HTTP operation needed, e.g. GET /orders, PUT /orders/:id"],
  "accessLevel": "read-only" | "write" | "read-write",
  "entities": ["order", "invoice", ...],
  "successCriteria": ["specific measurable condition that must be true for success"],
  "requiresWriteValidation": true | false
}

Rules:
- accessLevel is "read-only" if only GETs are needed, "write" if only mutations, "read-write" if both.
- requiresWriteValidation is true whenever data is created or mutated — we must read it back to confirm.
- successCriteria must be concrete and checkable from HTTP responses (e.g. "order returned by GET matches all fields submitted in PUT").
- Return ONLY the JSON array. No markdown, no explanations.`;

export async function parseGoals(input: GoalInput): Promise<ParsedGoal[]> {
    const userMessage = `API Documentation:
${input.apiDocumentation}

Customer ID: ${input.customerId}
API Version: ${input.apiVersion}
API Base URL: ${input.apiBaseUrl}

Goals to parse (${input.goals.length} total):
${input.goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}

Return the JSON array of parsed goals.`;

    return llmCompleteJSON<ParsedGoal[]>(SYSTEM_PROMPT, userMessage);
}
