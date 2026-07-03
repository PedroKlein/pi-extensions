/**
 * AI-powered PR review actions:
 * - Summary modal with structured sections and inline Q&A
 * - Clone & Review session creation
 * Optional BAML tier when pi-baml is available.
 */

import { readFileSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Task, PrMeta } from "./model.js";
import { fetchPrDiff, clonePrBranch, parsePrUrl } from "./github.js";

// Load BAML code at module level — non-fatal if file is missing
let REVIEW_PR_BAML: string | null = null;
try {
	REVIEW_PR_BAML = readFileSync(new URL('./review_pr.baml', import.meta.url).pathname, 'utf-8');
} catch {
	// BAML file unavailable — reviewPrWithBaml will be a no-op
}

/** Structured PR review returned by BAML ReviewPR function. */
interface PrReview {
	what: string;
	why: string;
	scope: string;
	risks: string[];
	verdict: string;
}

/**
 * Parse a PR review using BAML (typed structured output) and render to markdown.
 * Returns null if BAML code is unavailable or the call fails — caller should fall back.
 */
export async function reviewPrWithBaml(
	meta: PrMeta,
	diff: string,
	baml: any,
	modelRegistry: any,
): Promise<string | null> {
	if (!REVIEW_PR_BAML) return null;

	const review: PrReview = await baml.execBaml(
		REVIEW_PR_BAML,
		'ReviewPR',
		{
			owner: meta.owner,
			repo: meta.repo,
			number: meta.number,
			title: meta.title,
			author: meta.author,
			branch: meta.branch,
			state: meta.state,
			diff,
		},
		modelRegistry,
		'standard',
	);

	return renderPrReview(review);
}

function renderPrReview(review: PrReview): string {
	const lines: string[] = [];

	lines.push('## What');
	lines.push(review.what);
	lines.push('');

	lines.push('## Why');
	lines.push(review.why);
	lines.push('');

	lines.push('## Scope');
	lines.push(review.scope);
	lines.push('');

	lines.push('## Risks');
	if (review.risks.length === 0) {
		lines.push('No significant risks identified.');
	} else {
		for (const risk of review.risks) {
			lines.push(`- ${risk}`);
		}
	}
	lines.push('');

	lines.push('## Verdict');
	lines.push(review.verdict);

	return lines.join('\n');
}

// ── AI Summary Modal ──────────────────────────────────────────────────

const SUMMARY_PROMPT = `You are reviewing a pull request. Analyze the diff and produce a structured review.

PR: {owner}/{repo} #{number}
Title: {title}
Author: {author}
Branch: {branch}
State: {state}

Format your response in these exact sections:

## What
Brief description of what this PR does (2-3 sentences).

## Why
The motivation or problem being solved (1-2 sentences, infer from the diff if not explicit).

## Scope
- Files changed and rough scope (e.g. "3 files, ~120 lines added, ~40 removed")
- Key areas touched

## Risks
- Potential issues, missing error handling, edge cases
- Security concerns if any
- Breaking changes or backwards compatibility
- Test coverage gaps

## Verdict
One-line assessment: is this straightforward, needs attention, or concerning?

Be concise and practical. No filler. If you can't determine something from the diff, say so.`;

const QA_PROMPT = `You are answering a follow-up question about a pull request.

PR: {owner}/{repo} #{number}
Title: {title}

The user already saw a summary. They're now asking a specific question about the diff.
Answer concisely based on the diff content. If the answer isn't in the diff, say so.

User question: {question}`;

interface SummaryState {
	summary: string | null;
	qaHistory: { question: string; answer: string }[];
	loading: boolean;
	error: string | null;
}

/**
 * Show the AI summary modal for a review task.
 */
export async function showAiSummaryModal(
	task: Task,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	baml?: any,
): Promise<void> {
	if (!task.prMeta || !task.url) return;

	const prUrl = parsePrUrl(task.url);
	if (!prUrl) return;

	// Fetch diff with spinner
	const diff = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const loader = new BorderedLoader(_tui, theme, `Fetching diff: ${task.prMeta!.owner}/${task.prMeta!.repo} #${task.prMeta!.number}`);
		loader.onAbort = () => done(null);

		fetchPrDiff(prUrl, pi)
			.then((d) => done(d))
			.catch(() => done(null));

		return loader;
	});

	if (!diff) {
		ctx.ui.notify("Failed to fetch diff (is gh CLI installed and authenticated?)", "error");
		return;
	}

	// Truncate diff for LLM context (keep first ~30K chars)
	const maxDiffLen = 30000;
	const truncatedDiff = diff.length > maxDiffLen
		? diff.slice(0, maxDiffLen) + `\n\n[... diff truncated, ${diff.length - maxDiffLen} chars omitted]`
		: diff;

	const meta = task.prMeta;

	// Generate summary with spinner, then show modal
	const summaryText = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const loader = new BorderedLoader(_tui, theme, "Generating AI summary...");
		loader.onAbort = () => done(null);

		(async () => {
			// Tier 1: BAML — typed structured extraction
			if (baml?.available) {
				try {
					const bamlSummary = await reviewPrWithBaml(meta, truncatedDiff, baml, ctx.modelRegistry);
					if (bamlSummary) {
						done(bamlSummary);
						return;
					}
				} catch (err: any) {
					ctx.ui.notify(`⚠ BAML ReviewPR failed: ${(err as Error).message}. Using fallback.`, 'warning');
				}
			}

			// Tier 2: LLM via complete()
			generateSummary(meta, truncatedDiff, ctx)
				.then((s) => done(s))
				.catch(() => done(null));
		})();

		return loader;
	});

	if (!summaryText) {
		ctx.ui.notify("Failed to generate summary", "error");
		return;
	}

	// Show interactive summary modal with Q&A
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			return createSummaryUI({
				tui,
				theme,
				done,
				meta,
				diff: truncatedDiff,
				initialSummary: summaryText,
				ctx,
			});
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as any,
				width: "85%",
				minWidth: 60,
				maxHeight: "85%",
			},
		}
	);
}

async function generateSummary(
	meta: PrMeta,
	diff: string,
	ctx: ExtensionContext
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return null;

	const prompt = SUMMARY_PROMPT
		.replace("{owner}", meta.owner)
		.replace("{repo}", meta.repo)
		.replace("{number}", String(meta.number))
		.replace("{title}", meta.title)
		.replace("{author}", meta.author)
		.replace("{branch}", meta.branch)
		.replace("{state}", meta.state);

	const response = await complete(
		model,
		{
			systemPrompt: prompt,
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Here is the diff:\n\n${diff}` }],
				timestamp: Date.now(),
			}],
		},
		{ apiKey: auth.apiKey, headers: auth.headers }
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim() || null;
}

async function generateQaAnswer(
	meta: PrMeta,
	diff: string,
	question: string,
	ctx: ExtensionContext
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return null;

	const prompt = QA_PROMPT
		.replace("{owner}", meta.owner)
		.replace("{repo}", meta.repo)
		.replace("{number}", String(meta.number))
		.replace("{title}", meta.title)
		.replace("{question}", question);

	const response = await complete(
		model,
		{
			systemPrompt: prompt,
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Diff:\n\n${diff}\n\nQuestion: ${question}` }],
				timestamp: Date.now(),
			}],
		},
		{ apiKey: auth.apiKey, headers: auth.headers }
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim() || null;
}

// ── Summary UI Component ──────────────────────────────────────────────

interface SummaryUIOptions {
	tui: TUI;
	theme: any;
	done: (result: void) => void;
	meta: PrMeta;
	diff: string;
	initialSummary: string;
	ctx: ExtensionContext;
}

function createSummaryUI(opts: SummaryUIOptions) {
	const { tui, theme, done, meta, diff, initialSummary, ctx } = opts;

	let scrollOffset = 0;
	let qaHistory: { question: string; answer: string }[] = [];
	let askingQuestion = false;
	let loadingAnswer = false;
	let cachedLines: string[] | undefined;

	const questionInput = new Input();

	questionInput.onSubmit = (value: string) => {
		const q = value.trim();
		if (!q) {
			askingQuestion = false;
			refresh();
			return;
		}
		askingQuestion = false;
		loadingAnswer = true;
		refresh();

		generateQaAnswer(meta, diff, q, ctx)
			.then((answer) => {
				if (answer) {
					qaHistory.push({ question: q, answer });
				}
				loadingAnswer = false;
				// Auto-scroll to bottom after new answer
				scrollOffset = 99999;
				refresh();
			})
			.catch(() => {
				loadingAnswer = false;
				refresh();
			});
	};

	questionInput.onEscape = () => {
		askingQuestion = false;
		refresh();
	};

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	function pad(s: string, toWidth: number): string {
		const vis = visibleWidth(s);
		if (vis >= toWidth) return s;
		return s + " ".repeat(toWidth - vis);
	}

	function handleInput(data: string) {
		if (askingQuestion) {
			questionInput.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, Key.escape) || data === "q") {
			done(undefined);
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			scrollOffset = Math.max(0, scrollOffset - 3);
			refresh();
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			scrollOffset += 3;
			refresh();
			return;
		}

		if (data === "?" || data === "a") {
			askingQuestion = true;
			questionInput.setValue("");
			refresh();
			return;
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const innerW = width - 4; // │ + space + content + space + │
		const lines: string[] = [];

		const row = (content: string) => {
			const fitted = visibleWidth(content) > innerW
				? truncateToWidth(content, innerW)
				: pad(content, innerW);
			lines.push(theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│"));
		};
		const emptyRow = () => row("");

		// Top border
		const title = ` 👀 PR Review: ${meta.owner}/${meta.repo} #${meta.number} `;
		const titleLen = visibleWidth(title);
		const leftDash = 1;
		const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
		lines.push(
			theme.fg("accent", "╭" + "─".repeat(leftDash)) +
			theme.fg("accent", theme.bold(title)) +
			theme.fg("accent", "─".repeat(rightDash) + "╮")
		);

		// PR info line
		const stateColor = meta.state === "open" ? "success" : meta.state === "merged" ? "accent" : "error";
		row(
			theme.fg("muted", "by ") + meta.author +
			theme.fg("muted", " · ") + theme.fg(stateColor, meta.state) +
			theme.fg("muted", " · ") + theme.fg("dim", meta.branch)
		);
		emptyRow();

		// Build content lines (summary + Q&A)
		const contentLines: string[] = [];

		// Summary
		const summaryWrapped = wrapSummary(initialSummary, innerW - 2);
		contentLines.push(...summaryWrapped);

		// Q&A history
		if (qaHistory.length > 0) {
			contentLines.push("");
			contentLines.push(theme.fg("accent", "── Q&A ──"));
			for (const qa of qaHistory) {
				contentLines.push("");
				contentLines.push(theme.fg("accent", "❓ ") + theme.fg("text", qa.question));
				contentLines.push("");
				const answerLines = wrapTextWithAnsi(qa.answer, innerW - 4);
				for (const al of answerLines) {
					contentLines.push("  " + al);
				}
			}
		}

		if (loadingAnswer) {
			contentLines.push("");
			contentLines.push(theme.fg("dim", "⏳ Thinking..."));
		}

		// Apply scroll
		const maxVisible = 30;
		const maxScroll = Math.max(0, contentLines.length - maxVisible);
		scrollOffset = Math.min(scrollOffset, maxScroll);
		const hasScrollUp = scrollOffset > 0;
		const hasScrollDown = scrollOffset < maxScroll;

		if (hasScrollUp) {
			row(theme.fg("dim", "▲ k to scroll up"));
		}

		const visibleCount = maxVisible - (hasScrollUp ? 1 : 0) - (hasScrollDown ? 1 : 0);
		for (let i = scrollOffset; i < scrollOffset + visibleCount && i < contentLines.length; i++) {
			row(contentLines[i]);
		}

		if (hasScrollDown) {
			row(theme.fg("dim", "▼ j to scroll down"));
		}

		emptyRow();

		// Input area
		if (askingQuestion) {
			row(theme.fg("accent", "❓ Ask a question about this PR:"));
			const inputRendered = questionInput.render(innerW - 4);
			row("  " + (inputRendered[0] ?? ""));
			row(theme.fg("dim", "  Enter to ask · Esc to cancel"));
		} else {
			row(theme.fg("dim", "  ? ask a question · j/k scroll · Esc close"));
		}

		// Bottom border
		lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

		cachedLines = lines;
		return lines;
	}

	function wrapSummary(text: string, width: number): string[] {
		const lines: string[] = [];
		for (const rawLine of text.split("\n")) {
			// Style headings
			if (rawLine.startsWith("## ")) {
				lines.push(theme.fg("accent", theme.bold(rawLine.replace("## ", "── ") + " ──")));
				continue;
			}
			if (rawLine.startsWith("- ")) {
				const wrapped = wrapTextWithAnsi(rawLine, width - 2);
				for (const wl of wrapped) {
					lines.push("  " + wl);
				}
				continue;
			}
			if (rawLine.trim() === "") {
				lines.push("");
				continue;
			}
			const wrapped = wrapTextWithAnsi(rawLine, width);
			lines.push(...wrapped);
		}
		return lines;
	}

	return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
}

// ── Clone & Review Session ────────────────────────────────────────────

const REVIEW_SESSION_PROMPT = `You are conducting a thorough code review of a pull request.

PR: {owner}/{repo} #{number}
Title: {title}
Author: {author}
Branch: {branch}
State: {state}
URL: {url}

You have the full repository cloned locally and the diff available below.

Produce a comprehensive review with these sections:

## Summary
What this PR does and why (2-3 sentences).

## File-by-File Analysis
For each changed file, note:
- What changed and why
- Potential issues or improvements
- Code quality observations

## Security & Safety
- Any security concerns
- Input validation, auth checks, error handling gaps

## Testing
- Are changes adequately tested?
- What tests are missing?

## Overall Assessment
- Approve / Request Changes / Needs Discussion
- Key action items (numbered list)

After the review, ask the user if they want to drill into any specific area.

Here is the diff:

{diff}`;

/**
 * Clone a PR branch and open a new pi session for review.
 * Must be called from a command handler (needs ExtensionCommandContext for newSession).
 */
export async function startCloneReviewSession(
	task: Task,
	pi: ExtensionAPI,
	ctx: any // ExtensionCommandContext — has newSession
): Promise<void> {
	if (!task.prMeta || !task.url) return;

	const prUrl = parsePrUrl(task.url);
	if (!prUrl) return;

	const meta = task.prMeta;

	// Fetch diff and clone in parallel with spinner
	const result = await ctx.ui.custom<{ diff: string | null; cloneDir: string | null } | null>(
		(_tui: any, theme: any, _kb: any, done: any) => {
			const loader = new BorderedLoader(
				_tui,
				theme,
				`Cloning ${meta.owner}/${meta.repo} #${meta.number} and fetching diff...`
			);
			loader.onAbort = () => done(null);

			(async () => {
				const [diff, cloneDir] = await Promise.all([
					fetchPrDiff(prUrl, pi),
					clonePrBranch(prUrl, meta, pi),
				]);
				done({ diff, cloneDir });
			})().catch(() => done(null));

			return loader;
		}
	);

	if (!result) {
		ctx.ui.notify("Clone & Review cancelled", "info");
		return;
	}

	if (!result.cloneDir) {
		ctx.ui.notify("Failed to clone repository", "error");
		return;
	}

	const diff = result.diff ?? "(diff unavailable — use git diff to inspect changes)";

	// Truncate diff for the prompt
	const maxDiffLen = 30000;
	const truncatedDiff = diff.length > maxDiffLen
		? diff.slice(0, maxDiffLen) + `\n\n[... diff truncated, ${diff.length - maxDiffLen} chars omitted]`
		: diff;

	const reviewPrompt = REVIEW_SESSION_PROMPT
		.replace("{owner}", meta.owner)
		.replace("{repo}", meta.repo)
		.replace("{number}", String(meta.number))
		.replace("{title}", meta.title)
		.replace("{author}", meta.author)
		.replace("{branch}", meta.branch)
		.replace("{state}", meta.state)
		.replace("{url}", task.url)
		.replace("{diff}", truncatedDiff);

	ctx.ui.notify(`Opening review session in ${result.cloneDir}`, "info");

	await ctx.newSession({
		cwd: result.cloneDir,
		setup: async (sm: any) => {
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: reviewPrompt }],
				timestamp: Date.now(),
			});
		},
	});
}
