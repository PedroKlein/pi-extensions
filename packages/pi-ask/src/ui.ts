/**
 * TUI component for the pi-ask extension.
 * Split-panel layout with tabs, multi/single/text, annotations, and ephemeral LLM explain.
 */

import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { AskUserResult, NormalizedQuestion, Selection } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return [text];
	return wrapTextWithAnsi(text, width);
}

function pad(s: string, toWidth: number): string {
	const vis = visibleWidth(s);
	if (vis >= toWidth) return s;
	return s + " ".repeat(toWidth - vis);
}

// ── Explain cache per option ─────────────────────────────────────────────────

interface ExplainEntry {
	userQuestion?: string;
	answer: string;
}

// ── Main UI ──────────────────────────────────────────────────────────────────

export interface AskUserUIOptions {
	tui: TUI;
	theme: any;
	done: (result: AskUserResult) => void;
	questions: NormalizedQuestion[];
	model: Model<Api> | null;
	modelRegistry: ModelRegistry;
}

export function createAskUserUI(opts: AskUserUIOptions) {
	const { tui, theme, done, questions, model, modelRegistry } = opts;
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // +1 for Submit tab

	// ── State ──────────────────────────────────────────────────────────────

	let currentTab = 0;
	let cursorIndex = 0;
	let cachedLines: string[] | undefined;

	// Selections: questionId -> Set of selected values
	const selections = new Map<string, Map<string, Selection>>();

	// Free-text answers for "text" type questions
	const freeTextAnswers = new Map<string, string>();

	// Per-option explain cache: "questionId:optionValue" -> ExplainEntry[]
	const explainCache = new Map<string, ExplainEntry[]>();

	// Input modes
	let annotatingKey: string | null = null; // "questionId:optionValue" being annotated
	let askingKey: string | null = null; // "questionId:optionValue" being asked about
	let otherInputActive = false; // typing in "Other" field
	let textInputActive = false; // typing in text question
	let explainLoading = false;
	let explainAbort: AbortController | null = null;

	// Right panel scroll
	let rightScrollOffset = 0;
	let rightTotalLines = 0; // set during render
	let lastHighlightedValue: string | null = null; // reset scroll on cursor change
	const MAX_PANEL_HEIGHT = 18;

	// Left panel scroll
	let leftScrollOffset = 0;
	let leftTotalLines = 0;

	// Shared Input components
	const annotationInput = new Input();
	const askInput = new Input();
	const otherInput = new Input();
	const textInput = new Input();
	const noteInput = new Input();

	// Global note
	let globalNote = "";
	let noteInputActive = false;

	// ── Helpers ──────────────────────────────────────────────────────────────

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	function q(): NormalizedQuestion {
		return questions[currentTab] ?? questions[0];
	}

	/** Options including custom "Other" entries + the "Other" input entry */
	function optionsWithOther(): (NormalizedQuestion["options"][0] & { isOther?: boolean; isCustom?: boolean })[] {
		const cur = q();
		if (cur.type === "text") return [];
		const result: (NormalizedQuestion["options"][0] & { isOther?: boolean; isCustom?: boolean })[] = [...cur.options];

		// Include custom entries that were added via "Other"
		const sels = getSelections(cur.id);
		for (const sel of sels.values()) {
			if (sel.custom && !result.some((o) => o.value === sel.value)) {
				result.push({ value: sel.value, label: sel.label, isCustom: true });
			}
		}

		result.push({ value: "__other__", label: "Other: type your own...", isOther: true });
		return result;
	}

	// Use NUL as separator — never appears in user text
	function selKey(qId: string, val: string) {
		return `${qId}\0${val}`;
	}

	function parseSelKey(key: string): [string, string] {
		const idx = key.indexOf("\0");
		return [key.slice(0, idx), key.slice(idx + 1)];
	}

	function getSelections(qId: string): Map<string, Selection> {
		if (!selections.has(qId)) selections.set(qId, new Map());
		return selections.get(qId)!;
	}

	function isSelected(qId: string, val: string): boolean {
		return getSelections(qId).has(val);
	}

	function toggleSelection(qId: string, opt: { value: string; label: string }, custom = false) {
		const sel = getSelections(qId);
		const cur = q();
		if (cur.type === "single") {
			// Preserve annotation if re-selecting the same option
			const existing = sel.get(opt.value);
			sel.clear();
			sel.set(opt.value, {
				value: opt.value,
				label: opt.label,
				custom,
				annotation: existing?.annotation,
			});
		} else {
			if (sel.has(opt.value)) {
				sel.delete(opt.value);
			} else {
				sel.set(opt.value, { value: opt.value, label: opt.label, custom });
			}
		}
	}

	function isQuestionAnswered(qId: string): boolean {
		const cur = questions.find((qq) => qq.id === qId)!;
		if (cur.type === "text") return !!freeTextAnswers.get(qId)?.trim();
		return getSelections(qId).size > 0;
	}

	function allAnswered(): boolean {
		return questions.every((qq) => isQuestionAnswered(qq.id));
	}

	function buildResult(cancelled: boolean): AskUserResult {
		const answers: QuestionAnswer[] = questions.map((qq) => ({
			id: qq.id,
			selections: Array.from(getSelections(qq.id).values()),
			freeText: freeTextAnswers.get(qq.id),
		}));
		return { questions, answers, cancelled, globalNote: globalNote.trim() || undefined };
	}

	function submit() {
		done(buildResult(false));
	}

	function cancel() {
		if (explainAbort) {
			explainAbort.abort();
			explainAbort = null;
			explainLoading = false;
			refresh();
			return;
		}
		done(buildResult(true));
	}

	function advanceTab() {
		if (!isMulti) {
			submit();
			return;
		}
		if (currentTab < questions.length - 1) {
			currentTab++;
		} else {
			currentTab = questions.length; // Submit tab
		}
		cursorIndex = 0;
		leftScrollOffset = 0;
		refresh();
	}

	// ── LLM Explain ──────────────────────────────────────────────────────────

	async function explainOption(questionId: string, optionValue: string, userQuestion?: string) {
		if (!model) return;

		const cur = questions.find((qq) => qq.id === questionId)!;
		const opt = cur.options.find((o) => o.value === optionValue);
		if (!opt) return;

		const cacheKey = selKey(questionId, optionValue);
		const otherOpts = cur.options.filter((o) => o.value !== optionValue).map((o) => o.label).join(", ");

		let prompt: string;
		if (userQuestion) {
			prompt = [
				`Question being answered: "${cur.prompt}"`,
				`Option in question: "${opt.label}"`,
				otherOpts ? `Other options: ${otherOpts}` : "",
				cur.context ? `Context: ${cur.context}` : "",
				``,
				`User's question about this option: ${userQuestion}`,
				``,
				`Answer concisely in 2-3 short paragraphs.`,
			].filter(Boolean).join("\n");
		} else {
			prompt = [
				`Question being answered: "${cur.prompt}"`,
				`Option to explain: "${opt.label}"`,
				otherOpts ? `Other options: ${otherOpts}` : "",
				cur.context ? `Context: ${cur.context}` : "",
				``,
				`Explain this option concisely: trade-offs, when it's a good/bad fit, and how it compares to alternatives. 2-3 short paragraphs max.`,
			].filter(Boolean).join("\n");
		}

		explainLoading = true;
		explainAbort = new AbortController();
		refresh();

		try {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error("No API key");

			const response = await complete(
				model,
				{
					systemPrompt: "You explain options for decision-making. Be concise and practical. No markdown formatting.",
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal: explainAbort.signal },
			);

			if (response.stopReason === "aborted") return;

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (text) {
				const entries = explainCache.get(cacheKey) ?? [];
				entries.push({ userQuestion, answer: text });
				explainCache.set(cacheKey, entries);
			}
		} catch {
			// Silently fail — user can try again
		} finally {
			explainLoading = false;
			explainAbort = null;
			refresh();
		}
	}

	// ── Input callbacks ──────────────────────────────────────────────────────

	annotationInput.onSubmit = (value: string) => {
		if (annotatingKey) {
			const [qId, val] = parseSelKey(annotatingKey);
			const sel = getSelections(qId).get(val);
			if (sel) sel.annotation = value.trim() || undefined;
		}
		annotatingKey = null;
		refresh();
	};
	annotationInput.onEscape = () => {
		annotatingKey = null;
		refresh();
	};

	askInput.onSubmit = (value: string) => {
		if (askingKey) {
			const [qId, val] = parseSelKey(askingKey);
			const userQ = value.trim() || undefined;
			askingKey = null;
			refresh();
			explainOption(qId, val, userQ);
		}
	};
	askInput.onEscape = () => {
		askingKey = null;
		refresh();
	};

	otherInput.onSubmit = (value: string) => {
		const trimmed = value.trim();
		if (trimmed) {
			const cur = q();
			toggleSelection(cur.id, { value: trimmed, label: trimmed }, true);
			otherInputActive = false;
			otherInput.setValue("");
			if (cur.type === "single") {
				advanceTab();
			} else {
				refresh();
			}
		}
	};
	otherInput.onEscape = () => {
		otherInputActive = false;
		otherInput.setValue("");
		refresh();
	};

	textInput.onSubmit = (value: string) => {
		const cur = q();
		freeTextAnswers.set(cur.id, value.trim());
		textInputActive = false;
		advanceTab();
	};
	textInput.onEscape = () => {
		const cur = q();
		freeTextAnswers.set(cur.id, textInput.getValue().trim());
		textInputActive = false;
		refresh();
	};

	noteInput.onSubmit = (value: string) => {
		globalNote = value.trim();
		noteInputActive = false;
		refresh();
	};
	noteInput.onEscape = () => {
		globalNote = noteInput.getValue().trim();
		noteInputActive = false;
		refresh();
	};

	// ── Input handling ───────────────────────────────────────────────────────

	function handleInput(data: string) {
		// Route to active input
		if (annotatingKey) {
			annotationInput.handleInput(data);
			refresh();
			return;
		}
		if (askingKey) {
			askInput.handleInput(data);
			refresh();
			return;
		}
		if (otherInputActive) {
			otherInput.handleInput(data);
			refresh();
			return;
		}
		if (textInputActive) {
			textInput.handleInput(data);
			refresh();
			return;
		}
		if (noteInputActive) {
			noteInput.handleInput(data);
			refresh();
			return;
		}

		const cur = q();
		const opts = optionsWithOther();

		// Escape → cancel
		if (matchesKey(data, Key.escape)) {
			cancel();
			return;
		}

		// Tab navigation (multi-question)
		if (isMulti) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				cursorIndex = 0;
				leftScrollOffset = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				cursorIndex = 0;
				leftScrollOffset = 0;
				refresh();
				return;
			}
		}

		// Submit tab
		if (currentTab === questions.length) {
			if (matchesKey(data, Key.enter)) {
				submit();
			}
			if (data === "n") {
				noteInputActive = true;
				noteInput.setValue(globalNote);
				refresh();
			}
			return;
		}

		// Text type: Enter starts text input
		if (cur.type === "text") {
			if (matchesKey(data, Key.enter)) {
				textInputActive = true;
				textInput.setValue(freeTextAnswers.get(cur.id) ?? "");
				refresh();
			}
			return;
		}

		// ↑↓ navigation
		if (matchesKey(data, Key.up)) {
			cursorIndex = Math.max(0, cursorIndex - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			cursorIndex = Math.min(opts.length - 1, cursorIndex + 1);
			refresh();
			return;
		}

		// Space = toggle selection
		if (matchesKey(data, Key.space)) {
			const opt = opts[cursorIndex];
			if ((opt as any).isOther) {
				otherInputActive = true;
				otherInput.setValue("");
				refresh();
				return;
			}
			toggleSelection(cur.id, opt);
			if (cur.type === "single") {
				advanceTab();
				return;
			}
			refresh();
			return;
		}

		// Enter = confirm selections / select for single
		if (matchesKey(data, Key.enter)) {
			const opt = opts[cursorIndex];
			if ((opt as any).isOther) {
				otherInputActive = true;
				otherInput.setValue("");
				refresh();
				return;
			}
			if (cur.type === "single") {
				toggleSelection(cur.id, opt);
				advanceTab();
				return;
			}
			// Multi: Enter = confirm and advance
			if (getSelections(cur.id).size > 0) {
				advanceTab();
			}
			return;
		}

		// 'a' = annotate option (auto-selects if not already selected)
		if (data === "a") {
			const opt = opts[cursorIndex];
			if (opt && !(opt as any).isOther) {
				// Auto-select the option if not already selected
				if (!isSelected(cur.id, opt.value)) {
					toggleSelection(cur.id, opt, !!(opt as any).isCustom);
				}
				const key = selKey(cur.id, opt.value);
				annotatingKey = key;
				const existing = getSelections(cur.id).get(opt.value)?.annotation ?? "";
				annotationInput.setValue(existing);
				refresh();
			}
			return;
		}

		// '?' = ask about option
		if (data === "?") {
			const opt = opts[cursorIndex];
			if (opt && !(opt as any).isOther) {
				const key = selKey(cur.id, opt.value);
				askingKey = key;
				askInput.setValue("");
				refresh();
			}
			return;
		}

		// 'n' = global note
		if (data === "n") {
			noteInputActive = true;
			noteInput.setValue(globalNote);
			refresh();
			return;
		}

		// J/K = scroll detail panel
		if (data === "J" || data === "K") {
			if (rightTotalLines > MAX_PANEL_HEIGHT) {
				const maxScroll = rightTotalLines - MAX_PANEL_HEIGHT;
				if (data === "J") {
					rightScrollOffset = Math.min(maxScroll, rightScrollOffset + 3);
				} else {
					rightScrollOffset = Math.max(0, rightScrollOffset - 3);
				}
				refresh();
			}
			return;
		}
	}

	// ── Render ───────────────────────────────────────────────────────────────

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));
		const innerW = Math.max(0, width - 2); // usable width inside │...│
		const row = (content: string) => {
			add(theme.fg("accent", "│") + pad(truncateToWidth(content, innerW), innerW) + theme.fg("accent", "│"));
		};
		const emptyRow = () => row("");
		const cur = q();

		// ── Top border with title ──
		const title = " ask_user ";
		const borderChar = "─";
		const titleLen = visibleWidth(title);
		const borderLeft = 2;
		const borderRight = Math.max(0, width - borderLeft - titleLen - 2); // -2 for ╭ and ╮
		add(
			theme.fg("accent", "╭" + borderChar.repeat(borderLeft)) +
			theme.fg("accent", theme.bold(title)) +
			theme.fg("accent", borderChar.repeat(borderRight) + "╮")
		);

		// ── Tab bar (multi-question only) ──
		if (isMulti) {
			let tabLine = " ";
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === currentTab;
				const answered = isQuestionAnswered(questions[i].id);
				const icon = answered ? "■" : "□";
				const lbl = ` ${icon} ${questions[i].label} `;
				if (isActive) {
					tabLine += theme.bg("selectedBg", theme.fg("text", lbl)) + " ";
				} else {
					tabLine += theme.fg(answered ? "success" : "muted", lbl) + " ";
				}
			}
			// Submit tab
			const isSubmitTab = currentTab === questions.length;
			const submitLbl = " ✓ Submit ";
			if (isSubmitTab) {
				tabLine += theme.bg("selectedBg", theme.fg("text", submitLbl));
			} else {
				tabLine += theme.fg(allAnswered() ? "success" : "dim", submitLbl);
			}
			row(tabLine);
			emptyRow();
		}

		// ── Submit tab content ──
		if (currentTab === questions.length) {
			row(theme.fg("accent", theme.bold("  Review & Submit")));
			emptyRow();

			for (const qq of questions) {
				const answered = isQuestionAnswered(qq.id);
				const prefix = answered ? theme.fg("success", "  ✓ ") : theme.fg("warning", "  ○ ");
				let line = prefix + theme.fg("text", qq.label + ": ");
				if (qq.type === "text") {
					const txt = freeTextAnswers.get(qq.id) ?? "";
					line += txt ? theme.fg("muted", txt) : theme.fg("dim", "(empty)");
				} else {
					const sels = getSelections(qq.id);
					if (sels.size === 0) {
						line += theme.fg("dim", "(no selection)");
					} else {
						const labels = Array.from(sels.values()).map((s) => s.label);
						line += theme.fg("muted", labels.join(", "));
					}
				}
				row(line);

				// Show annotations
				for (const sel of getSelections(qq.id).values()) {
					if (sel.annotation) {
						row(theme.fg("dim", `      📝 "${sel.annotation}"`));
					}
				}
			}

			emptyRow();

			// Global note section
			if (noteInputActive) {
				row("  " + theme.fg("accent", "📝 Note:"));
				const noteRendered = noteInput.render(innerW - 6);
				for (const nl of noteRendered) {
					row("    " + nl);
				}
			} else if (globalNote) {
				row("  " + theme.fg("dim", `📝 Note: "${globalNote}"`));
				row(theme.fg("dim", "    Press n to edit"));
			} else {
				row(theme.fg("dim", "  Press n to add a note"));
			}

			emptyRow();
			const hint = allAnswered()
				? theme.fg("success", "  Press Enter to submit")
				: theme.fg("warning", "  Some questions are unanswered — navigate back with Tab/←→");
			row(hint);

			renderFooter(lines, width);
			cachedLines = lines;
			return lines;
		}

		// ── Question prompt ──
		const promptWrapped = wordWrap(cur.prompt, innerW - 4);
		for (const pl of promptWrapped) {
			row("  " + theme.fg("text", theme.bold(pl)));
		}
		if (cur.context) {
			const ctxWrapped = wordWrap(cur.context, innerW - 4);
			for (const cl of ctxWrapped) {
				row("  " + theme.fg("muted", cl));
			}
		}
		emptyRow();

		// ── Text type: full width input ──
		if (cur.type === "text") {
			if (textInputActive) {
				const inputLines = textInput.render(innerW - 2);
				for (const il of inputLines) {
					row("  " + il);
				}
			} else {
				const existing = freeTextAnswers.get(cur.id);
				if (existing) {
					row("  " + theme.fg("text", existing));
				}
				row(theme.fg("dim", "  Press Enter to type your answer"));
			}
			renderFooter(lines, width);
			cachedLines = lines;
			return lines;
		}

		// ── Split panel: Options (left) + Details (right) ──
		const leftWidth = Math.max(20, Math.floor(innerW * 0.45));
		const rightWidth = Math.max(15, innerW - leftWidth - 1); // 1 for separator │
		const opts = optionsWithOther();

		// Build left column lines
		const optionStartLines: number[] = [];
		const leftLines: string[] = [];
		for (let i = 0; i < opts.length; i++) {
			optionStartLines.push(leftLines.length);
			const opt = opts[i];
			const isOther = (opt as any).isOther === true;
			const selected = !isOther && isSelected(cur.id, opt.value);
			const highlighted = i === cursorIndex;

			// Checkbox/radio
			let prefix: string;
			if (isOther) {
				prefix = highlighted ? theme.fg("accent", " ⊕ ") : theme.fg("dim", " ⊕ ");
			} else if (cur.type === "single") {
				prefix = selected
					? (highlighted ? theme.fg("accent", " (●) ") : theme.fg("success", " (●) "))
					: (highlighted ? theme.fg("accent", " ( ) ") : theme.fg("dim", " ( ) "));
			} else {
				prefix = selected
					? (highlighted ? theme.fg("accent", " [x] ") : theme.fg("success", " [x] "))
					: (highlighted ? theme.fg("accent", " [ ] ") : theme.fg("dim", " [ ] "));
			}

			// Action badge for mode-switch options
			const hasAction = !isOther && opt.action?.type === "mode-switch";
			const actionMode = hasAction ? (opt.action as { mode: string }).mode : null;
			const actionBadge = actionMode
				? theme.fg("success", ` → /${actionMode}`)
				: "";

			const labelColor = highlighted ? "accent" : (selected ? "text" : (hasAction ? "success" : "text"));
			const recBadge = !isOther && opt.recommended ? theme.fg("warning", " ★") : "";
			const customBadge = (opt as any).isCustom ? theme.fg("dim", " (custom)") : "";
			let optLine = prefix + theme.fg(labelColor, opt.label) + actionBadge + recBadge + customBadge;
			if (highlighted) optLine = theme.bold(optLine);
			leftLines.push(truncateToWidth(optLine, leftWidth));

			// Annotation line
			if (!isOther && selected) {
				const sel = getSelections(cur.id).get(opt.value);
				const key = selKey(cur.id, opt.value);
				if (annotatingKey === key) {
					const prefix = theme.fg("accent", "     📝 ");
					const inputRendered = annotationInput.render(leftWidth - 10);
					const inputLine = inputRendered[0] ?? "";
					leftLines.push(truncateToWidth(prefix + (inputLine || theme.fg("dim", "type annotation...")), leftWidth));
				} else if (sel?.annotation) {
					leftLines.push(truncateToWidth(theme.fg("dim", `     📝 "${sel.annotation}"`), leftWidth));
				}
			}

			// "Other" input
			if (isOther && otherInputActive) {
				const inputRendered = otherInput.render(leftWidth - 6);
				leftLines.push(truncateToWidth("      " + (inputRendered[0] ?? ""), leftWidth));
			}
		}

		// "Ask" input at bottom of left column
		if (askingKey) {
			const [, val] = parseSelKey(askingKey);
			const optLabel = opts.find((o) => o.value === val)?.label ?? val;
			leftLines.push("");
			leftLines.push(truncateToWidth(theme.fg("muted", `  ? about ${optLabel}:`), leftWidth));
			const askRendered = askInput.render(leftWidth - 4);
			leftLines.push(truncateToWidth("    " + (askRendered[0] ?? ""), leftWidth));
			leftLines.push(truncateToWidth(theme.fg("dim", "    Enter for answer, empty = auto-explain"), leftWidth));
		}

		// Global note input at bottom of left column
		if (noteInputActive) {
			leftLines.push("");
			leftLines.push(truncateToWidth(theme.fg("accent", "  📝 Note:"), leftWidth));
			const noteRendered = noteInput.render(leftWidth - 4);
			leftLines.push(truncateToWidth("    " + (noteRendered[0] ?? ""), leftWidth));
		} else if (globalNote) {
			leftLines.push("");
			leftLines.push(truncateToWidth(theme.fg("dim", `  📝 "${globalNote}"`), leftWidth));
		}

		// Build right column lines
		const rightLines: string[] = [];
		const highlightedOpt = opts[cursorIndex];

		if (highlightedOpt && !(highlightedOpt as any).isOther) {
			// Title
			rightLines.push(theme.fg("accent", theme.bold(highlightedOpt.label)));
			rightLines.push("");

			// Description (word-wrapped)
			if (highlightedOpt.description) {
				const descWrapped = wordWrap(highlightedOpt.description, rightWidth - 2);
				for (const dl of descWrapped) {
					rightLines.push(dl);
				}
				rightLines.push("");
			}

			// Recommended badge
			if (highlightedOpt.recommended) {
				rightLines.push(theme.fg("warning", "★ Recommended"));
				rightLines.push("");
			}

			// Explain cache
			const cacheKey = selKey(cur.id, highlightedOpt.value);
			const entries = explainCache.get(cacheKey);
			if (entries && entries.length > 0) {
				for (const entry of entries) {
					if (entry.userQuestion) {
						rightLines.push(theme.fg("muted", `💬 "${entry.userQuestion}"`));
					} else {
						rightLines.push(theme.fg("muted", "💬 Auto-explain"));
					}
					const answerWrapped = wordWrap(entry.answer, rightWidth - 2);
					for (const al of answerWrapped) {
						rightLines.push(al);
					}
					rightLines.push("");
				}
			}

			// Loading indicator
			if (explainLoading) {
				rightLines.push(theme.fg("dim", "⏳ Thinking..."));
			}

			// Annotation preview
			const sel = getSelections(cur.id).get(highlightedOpt.value);
			if (sel?.annotation) {
				rightLines.push(theme.fg("dim", "─".repeat(Math.min(20, rightWidth - 2))));
				rightLines.push(theme.fg("muted", `📝 Your note: "${sel.annotation}"`));
			}
		} else if ((highlightedOpt as any)?.isOther) {
			rightLines.push(theme.fg("dim", "Type a custom answer"));
			rightLines.push(theme.fg("dim", "if none of the options fit."));
		}

		// Reset scroll when highlighted option changes
		const highlightedValue = highlightedOpt?.value ?? null;
		if (highlightedValue !== lastHighlightedValue) {
			lastHighlightedValue = highlightedValue;
			rightScrollOffset = 0;
		}

		// Auto-scroll left panel to keep cursor visible
		leftTotalLines = leftLines.length;
		const leftMaxVisible = MAX_PANEL_HEIGHT;
		const cursorLineStart = optionStartLines[cursorIndex] ?? 0;
		const cursorLineEnd = (cursorIndex + 1 < optionStartLines.length ? optionStartLines[cursorIndex + 1] : leftLines.length) - 1;
		if (cursorLineStart < leftScrollOffset) {
			leftScrollOffset = cursorLineStart;
		} else if (cursorLineEnd >= leftScrollOffset + leftMaxVisible) {
			leftScrollOffset = cursorLineEnd - leftMaxVisible + 1;
		}
		leftScrollOffset = Math.max(0, Math.min(leftScrollOffset, Math.max(0, leftTotalLines - leftMaxVisible)));

		// Build visible left lines with scroll indicators
		const visibleLeft: string[] = [];
		const leftHasScrollUp = leftScrollOffset > 0;
		const leftHasScrollDown = leftScrollOffset + leftMaxVisible < leftTotalLines;

		if (leftHasScrollUp) {
			visibleLeft.push(theme.fg("dim", " ▲ more above"));
		}

		const leftStartLine = leftScrollOffset;
		const leftVisibleCount = leftHasScrollUp && leftHasScrollDown
			? leftMaxVisible - 2
			: (leftHasScrollUp || leftHasScrollDown ? leftMaxVisible - 1 : leftMaxVisible);
		for (let l = leftStartLine; l < leftStartLine + leftVisibleCount && l < leftTotalLines; l++) {
			visibleLeft.push(leftLines[l]);
		}

		if (leftHasScrollDown) {
			visibleLeft.push(theme.fg("dim", " ▼ more below"));
		}

		// Apply scroll + max height to right panel
		rightTotalLines = rightLines.length;
		const maxScroll = Math.max(0, rightLines.length - MAX_PANEL_HEIGHT);
		rightScrollOffset = Math.min(rightScrollOffset, maxScroll);

		// Build visible right lines with scroll indicators
		const visibleRight: string[] = [];
		const hasScrollUp = rightScrollOffset > 0;
		const hasScrollDown = rightScrollOffset < maxScroll;

		if (hasScrollUp) {
			visibleRight.push(theme.fg("dim", "▲ K to scroll up"));
		}

		const startLine = rightScrollOffset;
		const visibleCount = hasScrollUp && hasScrollDown
			? MAX_PANEL_HEIGHT - 2
			: (hasScrollUp || hasScrollDown ? MAX_PANEL_HEIGHT - 1 : MAX_PANEL_HEIGHT);
		for (let r = startLine; r < startLine + visibleCount && r < rightLines.length; r++) {
			visibleRight.push(rightLines[r]);
		}

		if (hasScrollDown) {
			visibleRight.push(theme.fg("dim", "▼ J to scroll down"));
		}

		// Merge left + right columns
		const mergeHeight = Math.max(visibleLeft.length, visibleRight.length, 3);
		const sep = theme.fg("accent", "│");

		for (let i = 0; i < mergeHeight; i++) {
			const left = pad(visibleLeft[i] ?? "", leftWidth);
			const right = truncateToWidth(visibleRight[i] ?? "", rightWidth - 1);
			const rightPadded = pad(right, rightWidth - 1);
			add(theme.fg("accent", "│") + left + sep + " " + rightPadded + theme.fg("accent", "│"));
		}

		renderFooter(lines, width);
		cachedLines = lines;
		return lines;
	}

	function renderFooter(lines: string[], width: number) {
		const innerW = Math.max(0, width - 2);
		const addLine = (s: string) => lines.push(truncateToWidth(s, width));
		const fRow = (content: string) => {
			addLine(theme.fg("accent", "│") + pad(truncateToWidth(content, innerW), innerW) + theme.fg("accent", "│"));
		};

		// Minimum usable height for the component
		const minHeight = 10;
		const footerSize = 3; // empty line + help line + bottom border
		while (lines.length < minHeight - footerSize) {
			fRow("");
		}

		fRow(""); // empty line

		// Help line
		let help: string;
		if (annotatingKey) {
			help = "  Enter save • Esc cancel";
		} else if (askingKey) {
			help = "  Enter ask • Esc cancel • Empty = auto-explain";
		} else if (otherInputActive) {
			help = "  Enter save • Esc cancel";
		} else if (textInputActive) {
			help = "  Enter save • Esc cancel";
		} else if (noteInputActive) {
			help = "  Enter save note • Esc cancel";
		} else {
			const parts: string[] = ["↑↓ navigate", "Space select"];
			parts.push("a annotate");
			parts.push("? explain");
			parts.push("n note");
			if (rightTotalLines > MAX_PANEL_HEIGHT) parts.push("J/K scroll");
			if (isMulti) parts.push("Tab/←→ question");
			if (!isMulti) {
				parts.push("Enter submit");
			} else if (q().type === "multi") {
				parts.push("Enter next");
			}
			parts.push("Esc cancel");
			help = "  " + parts.join(" • ");
		}
		fRow(theme.fg("dim", help));

		// Bottom border
		addLine(theme.fg("accent", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"));
	}

	// ── Return component ─────────────────────────────────────────────────────

	return {
		render,
		invalidate: () => { cachedLines = undefined; },
		handleInput,
	};
}
