/**
 * Parser: extracts structured questions from the last assistant message via a quick LLM call.
 * Used by the /answer command.
 */

import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Question } from "./types.js";

const SYSTEM_PROMPT = `You extract questions and options from an assistant message.
Return ONLY valid JSON — no markdown, no explanation, no code fences.

Schema:
[
  {
    "id": "q1",
    "label": "Short label",
    "prompt": "The full question text",
    "type": "single" | "multi" | "text",
    "context": "Optional help text",
    "options": [
      { "value": "opt1", "label": "Option 1", "description": "Brief description", "recommended": false }
    ]
  }
]

Rules:
- type "single" when the message implies pick ONE (e.g. "which", "do you prefer")
- type "multi" when the message implies pick SEVERAL (e.g. "which of these", "select all")
- type "text" for open-ended questions with no predefined options
- Set recommended: true if the assistant explicitly recommended an option
- Keep descriptions short (1-2 sentences)
- If the message contains no questions, return []
- Use meaningful short labels for each question (2-3 words max)`;

export async function parseAssistantMessage(
	messageText: string,
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<Question[]> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	}

	const response = await complete(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: messageText }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") return [];

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!text) return [];

	// Extract JSON array from response (strip any accidental markdown fences)
	const jsonStr = extractJSON(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) return [];

	// Validate and normalize
	return parsed
		.filter((q: any) => q && typeof q.prompt === "string" && typeof q.type === "string")
		.map((q: any, i: number) => ({
			id: q.id ?? `q${i + 1}`,
			label: q.label,
			prompt: q.prompt,
			type: ["single", "multi", "text"].includes(q.type) ? q.type : "single",
			context: q.context,
			options: Array.isArray(q.options)
				? q.options
					.filter((o: any) => o && typeof o.label === "string")
					.map((o: any) => ({
						value: o.value ?? o.label,
						label: o.label,
						description: o.description,
						recommended: o.recommended === true,
					}))
				: undefined,
		})) as Question[];
}

function extractJSON(text: string): string {
	// Strip markdown code fences
	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();

	// Find the JSON array
	const start = text.indexOf("[");
	if (start === -1) return text;

	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaping) { escaping = false; continue; }
			if (char === "\\") { escaping = true; continue; }
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; continue; }
		if (char === "[") depth++;
		if (char === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return text;
}
