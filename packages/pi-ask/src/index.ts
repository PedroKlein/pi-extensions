/**
 * pi-ask extension
 *
 * Registers:
 * - `ask_user` tool: the agent calls this to ask the user structured questions
 * - `/answer` command: parses last assistant message into the same TUI
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { parseAssistantMessage } from "./parser.js";
import { createAskUserUI } from "./ui.js";
import type { AskUserResult, NormalizedQuestion, Question } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeQuestions(raw: Question[]): NormalizedQuestion[] {
	return raw.map((q, i) => ({
		...q,
		label: q.label || `Q${i + 1}`,
		options: q.options ?? [],
	}));
}

function formatResultForLLM(result: AskUserResult): string {
	if (result.cancelled) {
		return "User cancelled the questionnaire without answering. Proceed with your best judgment — use recommended options where specified, make reasonable choices elsewhere.";
	}

	const lines: string[] = ["User answers:"];
	for (const ans of result.answers) {
		const q = result.questions.find((qq) => qq.id === ans.id);
		const label = q?.label ?? ans.id;

		if (q?.type === "text") {
			const text = ans.freeText?.trim();
			if (text) {
				lines.push(`- ${label}: ${text}`);
			}
			continue;
		}

		if (ans.selections.length === 0) continue;

		for (const sel of ans.selections) {
			const customTag = sel.custom ? " (custom)" : "";
			lines.push(`- ${label}: ${sel.label}${customTag}`);
			if (sel.annotation) {
				lines.push(`    → "${sel.annotation}"`);
			}
		}
	}

	return lines.length === 1 ? "User submitted with no answers." : lines.join("\n");
}

function appendGlobalNote(text: string, result: AskUserResult): string {
	if (result.globalNote?.trim()) {
		return text + `\n- Additional notes: ${result.globalNote.trim()}`;
	}
	return text;
}

function reportNestedUsage(
	pi: ExtensionAPI,
	operation: string,
	selectedModel: Model<Api>,
	response: AssistantMessage,
	durationMs: number,
): void {
	pi.events.emit("pi-audit:usage", {
		source: "pi-ask",
		operation,
		model: `${selectedModel.provider}/${selectedModel.id}`,
		input: response.usage.input,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		output: response.usage.output,
		reasoning: response.usage.reasoning ?? 0,
		durationMs,
		trigger: "user",
		status: response.stopReason === "error" || response.stopReason === "aborted" ? "error" : "complete",
		route: `${response.provider}/${response.model}`,
	});
}

// ── Schema ───────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value identifier for this option" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Detailed description shown in side panel when option is highlighted. Always provide this." })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark as recommended (shows ★ badge)" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question identifier" }),
	label: Type.Optional(Type.String({ description: "Short tab label (2-3 words), defaults to Q1, Q2..." })),
	prompt: Type.String({ description: "Full question text" }),
	type: StringEnum(["single", "multi", "text"] as const, { description: "single=pick one, multi=pick many, text=free input" }),
	context: Type.Optional(Type.String({ description: "Help text shown below the question" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Choices (required for single/multi, omit for text)" })),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One or more questions to present to the user" }),
});

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Tool registration ──────────────────────────────────────────────────

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Present structured questions to the user via an interactive TUI form. " +
			"Use this tool whenever you need to ask the user to choose between options, confirm decisions, or provide input. " +
			"Supports single-select (pick one), multi-select (pick many), and free-text questions. " +
			"Users can annotate their selections with extra context and ask clarifying questions about options. " +
			"Always provide a description for each option — it is shown in the detail panel when the option is highlighted.",
		promptSnippet: "Ask the user structured questions via an interactive TUI (single/multi select, free text, with per-option annotations)",
		promptGuidelines: [
			"ALWAYS use ask_user when you need user input on choices or decisions. Never list options as plain text and ask the user to pick.",
			"Provide a meaningful 'description' for EVERY option — it is shown in a detail panel and helps the user decide.",
			"Use 'recommended: true' on options you think are best, with reasoning in the description.",
			"Use 'multi' type when several options could apply, 'single' when exactly one must be chosen, 'text' for open-ended questions.",
			"For questions that need context or explanation, present the context in your chat message before calling ask_user. Keep the 'prompt' field short (one line) — it can reference what you explained in chat. Do not cram analysis into prompt or context fields.",
		],
		parameters: AskUserParams,
		exposure: "model-only",
		executionMode: "sequential",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("ask_user requires interactive mode.");
			}

			const questions = normalizeQuestions(params.questions as Question[]);
			if (questions.length === 0) {
				throw new Error("No questions provided.");
			}

			// Validate: single/multi need options
			for (const q of questions) {
				if ((q.type === "single" || q.type === "multi") && q.options.length === 0) {
					throw new Error(`Question "${q.id}" is type "${q.type}" but has no options.`);
				}
			}

			const selectedModel = ctx.model ?? null;
			const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
				return createAskUserUI({
					tui,
					theme,
					done,
					questions,
					model: selectedModel,
					modelRegistry: ctx.modelRegistry,
					onResponse: selectedModel
						? (response, durationMs) => reportNestedUsage(pi, "option-explain", selectedModel, response, durationMs)
						: undefined,
				});
			});

			const text = appendGlobalNote(formatResultForLLM(result), result);

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) ?? [];
			const count = qs.length;
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			if (count === 1 && qs[0]?.prompt) {
				text += theme.fg("muted", truncateToWidth(qs[0].prompt, 70));
			} else {
				const labels = qs.map((q, i) => q.label || `Q${i + 1}`).join(", ");
				text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
				if (labels) {
					text += theme.fg("dim", ` (${truncateToWidth(labels, 50)})`);
				}
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserResult | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines: string[] = [];
			for (const ans of details.answers) {
				const q = details.questions.find((qq) => qq.id === ans.id);
				const label = q?.label ?? ans.id;
				if (q?.type === "text") {
					if (ans.freeText?.trim()) {
						lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${ans.freeText.trim()}`);
					}
					continue;
				}
				for (const sel of ans.selections) {
					const customTag = sel.custom ? theme.fg("dim", " (custom)") : "";
					lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${sel.label}${customTag}`);
					if (sel.annotation) {
						lines.push(theme.fg("dim", `    → "${sel.annotation}"`));
					}
				}
			}
			if (details.globalNote?.trim()) {
				lines.push(theme.fg("dim", `📝 Note: "${details.globalNote.trim()}"`));
			}
			return new Text(lines.length > 0 ? lines.join("\n") : theme.fg("dim", "No answers"), 0, 0);
		},
	});

	// ── /answer command ────────────────────────────────────────────────────

	pi.registerCommand("answer", {
		description: "Parse last assistant message into an interactive questionnaire",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find last assistant message
			const branch = ctx.sessionManager.getBranch();
			let lastText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastText) {
				ctx.ui.notify("No assistant message found", "warning");
				return;
			}

			// Parse with LLM via loader
			const questions = await ctx.ui.custom<Question[] | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions with ${ctx.model!.id}...`);
				loader.onAbort = () => done(null);

				parseAssistantMessage(
					lastText!,
					ctx.model!,
					ctx.modelRegistry,
					loader.signal,
					(response, durationMs) => reportNestedUsage(pi, "question-extract", ctx.model!, response, durationMs),
				)
					.then((qs) => done(qs))
					.catch(() => done(null));

				return loader;
			});

			if (!questions || questions.length === 0) {
				ctx.ui.notify(questions === null ? "Cancelled" : "No questions found in last message", "info");
				return;
			}

			const normalized = normalizeQuestions(questions);
			const selectedModel = ctx.model ?? null;

			// Open the same TUI
			const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
				return createAskUserUI({
					tui,
					theme,
					done,
					questions: normalized,
					model: selectedModel,
					modelRegistry: ctx.modelRegistry,
					onResponse: selectedModel
						? (response, durationMs) => reportNestedUsage(pi, "option-explain", selectedModel, response, durationMs)
						: undefined,
				});
			});

			if (result.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const text = appendGlobalNote(formatResultForLLM(result), result);
			pi.sendUserMessage(text);
		},
	});
}
