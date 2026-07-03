/**
 * pi-ask extension
 *
 * Registers:
 * - `ask_user` tool: the agent calls this to ask the user structured questions
 * - `/answer` command: parses last assistant message into the same TUI
 * - `before_agent_start` prompt enforcement
 *
 * Supports action options (e.g., mode-switch) that emit events via pi.events.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { parseAssistantMessage } from "./parser.js";
import { createAskUserUI } from "./ui.js";
import type { AskUserResult, NormalizedQuestion, OptionAction, Question } from "./types.js";

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

/** Collect all actions from selected options in a result */
function collectActions(result: AskUserResult): OptionAction[] {
	const actions: OptionAction[] = [];
	if (result.cancelled) return actions;

	for (const ans of result.answers) {
		const q = result.questions.find((qq) => qq.id === ans.id);
		if (!q || q.type === "text") continue;

		for (const sel of ans.selections) {
			const opt = q.options?.find((o) => o.value === sel.value);
			if (opt?.action) {
				actions.push(opt.action);
			}
		}
	}
	return actions;
}

/** Fire collected actions via the event bus */
function fireActions(pi: ExtensionAPI, actions: OptionAction[]): void {
	for (const action of actions) {
		if (action.type === "mode-switch") {
			pi.events.emit("pi-ask:mode-switch", { mode: action.mode });
		}
	}
}

// ── Schema ───────────────────────────────────────────────────────────────────

const ActionSchema = Type.Object({
	type: StringEnum(["mode-switch"] as const, { description: "Action type" }),
	mode: Type.Optional(Type.String({ description: "Target mode for mode-switch (e.g. 'build', 'plan', 'ask', 'brainstorm')" })),
});

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value identifier for this option" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Detailed description shown in side panel when option is highlighted. Always provide this." })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark as recommended (shows ★ badge)" })),
	action: Type.Optional(ActionSchema),
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
			"Always provide a description for each option — it is shown in the detail panel when the option is highlighted. " +
			"Options can include an 'action' field to trigger side effects like switching modes.",
		promptSnippet: "Ask the user structured questions via an interactive TUI (single/multi select, free text, with per-option annotations)",
		promptGuidelines: [
			"ALWAYS use ask_user when you need user input on choices or decisions. Never list options as plain text and ask the user to pick.",
			"Provide a meaningful 'description' for EVERY option — it is shown in a detail panel and helps the user decide.",
			"Use 'recommended: true' on options you think are best, with reasoning in the description.",
			"Use 'multi' type when several options could apply, 'single' when exactly one must be chosen, 'text' for open-ended questions.",
			"To switch modes (e.g., from brainstorm to build), add action: { type: 'mode-switch', mode: 'build' } to the option. The mode switch happens automatically when the user selects it.",
			"For questions that need context or explanation, present the context in your chat message before calling ask_user. Keep the 'prompt' field short (one line) — it can reference what you explained in chat. Do not cram analysis into prompt or context fields.",
		],
		parameters: AskUserParams,

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

			const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
				return createAskUserUI({
					tui,
					theme,
					done,
					questions,
					model: ctx.model ?? null,
					modelRegistry: ctx.modelRegistry,
				});
			});

			// Fire any actions from selected options
			const actions = collectActions(result);
			fireActions(pi, actions);

			const text = appendGlobalNote(formatResultForLLM(result), result);

			// Append action info to LLM output
			const actionLines: string[] = [];
			for (const action of actions) {
				if (action.type === "mode-switch") {
					actionLines.push(`[Mode switched to: ${action.mode}]`);
				}
			}

			const fullText = actionLines.length > 0
				? text + "\n\n" + actionLines.join("\n")
				: text;

			return {
				content: [{ type: "text", text: fullText }],
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
					const opt = q?.options?.find((o) => o.value === sel.value);
					const customTag = sel.custom ? theme.fg("dim", " (custom)") : "";
					const actionTag = opt?.action?.type === "mode-switch"
						? theme.fg("accent", ` → /${opt.action.mode}`)
						: "";
					lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${sel.label}${customTag}${actionTag}`);
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

				parseAssistantMessage(lastText!, ctx.model!, ctx.modelRegistry, loader.signal)
					.then((qs) => done(qs))
					.catch(() => done(null));

				return loader;
			});

			if (!questions || questions.length === 0) {
				ctx.ui.notify(questions === null ? "Cancelled" : "No questions found in last message", "info");
				return;
			}

			const normalized = normalizeQuestions(questions);

			// Open the same TUI
			const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
				return createAskUserUI({
					tui,
					theme,
					done,
					questions: normalized,
					model: ctx.model ?? null,
					modelRegistry: ctx.modelRegistry,
				});
			});

			if (result.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Fire any actions from selected options
			const actions = collectActions(result);
			fireActions(pi, actions);

			// Send as user message
			const text = appendGlobalNote(formatResultForLLM(result), result);
			const actionLines: string[] = [];
			for (const action of actions) {
				if (action.type === "mode-switch") {
					actionLines.push(`[Mode switched to: ${action.mode}]`);
				}
			}
			const fullText = actionLines.length > 0
				? text + "\n\n" + actionLines.join("\n")
				: text;
			pi.sendUserMessage(fullText);
		},
	});

	// ── Prompt enforcement ─────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nWhen you need to ask the user to choose between options or make decisions, ALWAYS use the ask_user tool. " +
				"Do not present numbered lists of options in plain text.",
		};
	});
}
