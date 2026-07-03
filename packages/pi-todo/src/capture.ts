/**
 * AI-powered task capture from natural language.
 * Uses Pi's current LLM provider, with a heuristic fallback.
 * Optional BAML tier when pi-baml is available.
 */

import { readFileSync } from "node:fs";
import { complete, type Model } from "@earendil-works/pi-ai";
import type { Task, TaskType, TaskPriority } from "./model.js";
import { TASK_TYPES, TASK_PRIORITIES } from "./model.js";

// Load BAML code at module level — non-fatal if file is missing
let PARSE_TASK_BAML: string | null = null;
try {
	PARSE_TASK_BAML = readFileSync(new URL('./parse_task.baml', import.meta.url).pathname, 'utf-8');
} catch {
	// BAML file unavailable — parseTaskWithBaml will be a no-op
}

/**
 * Parse a task from natural language using BAML (typed structured output).
 * Returns null if BAML code is unavailable or the call fails — caller should fall back.
 */
export async function parseTaskWithBaml(
	text: string,
	baml: any,
	modelRegistry: any,
): Promise<Partial<Task> | null> {
	if (!PARSE_TASK_BAML) return null;

	const now = new Date();
	const current_date = `${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} (${now.toISOString().split('T')[0]})`;

	const raw = await baml.execBaml(
		PARSE_TASK_BAML,
		'ParseTask',
		{ text, current_date },
		modelRegistry,
		'light',
	);

	const result: Partial<Task> = {};
	if (typeof raw.title === 'string') result.title = raw.title;
	if (typeof raw.type === 'string' && (TASK_TYPES as readonly string[]).includes(raw.type)) result.type = raw.type as TaskType;
	if (typeof raw.priority === 'string' && (TASK_PRIORITIES as readonly string[]).includes(raw.priority)) result.priority = raw.priority as TaskPriority;
	if (typeof raw.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due_date)) result.dueDate = raw.due_date;
	if (typeof raw.description === 'string') result.description = raw.description;

	return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse a task from natural language using the LLM.
 */
export async function parseTaskWithLLM(
	text: string,
	model: Model,
	apiKey: string,
	headers?: Record<string, string>
): Promise<Partial<Task>> {
	// Build current date context from local time
	const now = new Date();
	const isoDate = now.toISOString().split("T")[0];
	const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
	const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const prompt = `Parse this task description into structured fields. Return ONLY valid JSON, no markdown fences.

Current date: ${dayName}, ${dateStr} (${isoDate})

Task: "${text}"

Available types: ${JSON.stringify([...TASK_TYPES])}
Available priorities: ${JSON.stringify([...TASK_PRIORITIES])}

Return a JSON object with these fields (omit fields you can't confidently infer):
{
  "title": "concise task title",
  "type": "one of the available types",
  "priority": "one of the available priorities",
  "dueDate": "YYYY-MM-DD if a date is mentioned, otherwise omit",
  "description": "concise 2-3 sentence description"
}

Rules:
- title: Clean, concise version of the task. Don't just echo the input.
- type: "bug" for fixing issues, "feature" for new capabilities, "chore" for maintenance, "research" for investigation, "review" for code/PR reviews, "personal" for non-work.
- priority: "high" for urgent/blocking, "low" for nice-to-have, "medium" for normal.
- dueDate: Only include if a specific date is mentioned or strongly implied. Use YYYY-MM-DD format. Resolve relative dates ("next Friday", "tomorrow", "in 2 weeks") using the current date above.
- description: A concise 2-3 sentence summary that captures the key details, context, and intent. Distill the input into something future-you can understand at a glance.`;

	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(model, { messages }, { apiKey, headers });

	const responseText = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	// Extract JSON from response (handle potential markdown fences)
	const jsonMatch = responseText.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return parseTaskFallback(text);
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		const result: Partial<Task> = {};

		if (typeof parsed.title === "string") result.title = parsed.title;
		if (typeof parsed.type === "string" && TASK_TYPES.includes(parsed.type as TaskType)) result.type = parsed.type;
		if (typeof parsed.priority === "string" && TASK_PRIORITIES.includes(parsed.priority as TaskPriority))
			result.priority = parsed.priority;
		if (typeof parsed.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate))
			result.dueDate = parsed.dueDate;
		if (typeof parsed.description === "string") result.description = parsed.description;

		return result;
	} catch {
		return parseTaskFallback(text);
	}
}

/**
 * Heuristic fallback when LLM is unavailable.
 */
export function parseTaskFallback(text: string): Partial<Task> {
	const lower = text.toLowerCase();
	const result: Partial<Task> = {
		title: text,
		type: "chore",
		priority: "medium",
	};

	// Type heuristics
	if (lower.includes("bug") || lower.includes("fix") || lower.includes("broken") || lower.includes("error")) {
		result.type = "bug";
	} else if (lower.includes("add") || lower.includes("implement") || lower.includes("feature") || lower.includes("new")) {
		result.type = "feature";
	} else if (lower.includes("research") || lower.includes("investigate") || lower.includes("look into") || lower.includes("explore")) {
		result.type = "research";
	} else if (lower.includes("personal") || lower.includes("home") || lower.includes("errand")) {
		result.type = "personal";
	} else if (lower.includes("idea") || lower.includes("consider") || lower.includes("maybe")) {
		result.type = "research";
	}

	// Priority heuristics
	if (lower.includes("urgent") || lower.includes("critical") || lower.includes("asap") || lower.includes("blocking")) {
		result.priority = "high";
	} else if (lower.includes("low priority") || lower.includes("nice to have") || lower.includes("eventually") || lower.includes("someday")) {
		result.priority = "low";
	}

	// Simple date detection
	const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
	if (dateMatch) {
		result.dueDate = dateMatch[1];
	}

	return result;
}
