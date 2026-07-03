/**
 * pi-status — Context bar compositor + LLM environment injection.
 *
 * Owns the context-bar widget. Renders built-in segments (model, tokens,
 * cost, thinking, branch) and accepts external segments from other extensions
 * via pi-status:register / pi-status:update events.
 *
 * Also injects a small environment block into the system prompt:
 * git branch, context usage %, worktree warning.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { RegisterPayload, Segment, UpdatePayload } from "./types.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const THINKING_COLORS: Record<string, string> = {
	off: "dim", minimal: "dim", low: "dim",
	medium: "accent", high: "warning", xhigh: "error",
};

// ─── Session Stats (cumulative I/O tokens + cost) ──────────────────────────

interface SessionStats {
	input: number;
	output: number;
	cost: number;
}

class SessionStatsCache {
	private processedEntries = 0;
	private totals: SessionStats = { input: 0, output: 0, cost: 0 };

	reset(): void {
		this.processedEntries = 0;
		this.totals = { input: 0, output: 0, cost: 0 };
	}

	sync(ctx: ExtensionContext): SessionStats {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length < this.processedEntries) this.reset();

		for (let i = this.processedEntries; i < branch.length; i++) {
			const entry = branch[i] as any;
			if (entry?.type !== "message") continue;
			if (!entry.message || entry.message.role !== "assistant") continue;
			const usage = entry.message.usage;
			this.totals.input += usage?.input ?? 0;
			this.totals.output += usage?.output ?? 0;
			this.totals.cost += usage?.cost?.total ?? 0;
		}

		this.processedEntries = branch.length;
		return { ...this.totals };
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
	}
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function shortModel(model: { name?: string; id: string } | undefined): string {
	if (!model) return "no-model";
	return (model.name ?? model.id)
		.replace(/\s*\([^)]*\)/g, "")
		.replace(/^Claude\s+/i, "")
		.replace(/^Anthropic:\s+/i, "")
		.trim();
}

function buildBar(pct: number, width: number, theme: any): string {
	const clamped = Math.max(0, Math.min(1, pct));
	const filled = Math.round(clamped * width);
	const empty = width - filled;
	const color = clamped >= 0.9 ? "error" : clamped >= 0.6 ? "warning" : "success";
	return theme.fg(color, "▓".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function piStatus(pi: ExtensionAPI): void {
	// Skip in subagent child processes
	if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) return;

	const segments = new Map<string, Segment>();
	const statsCache = new SessionStatsCache();
	let latestCtx: ExtensionContext | null = null;
	let gitBranch: string | null = null;
	let worktreeWarning: string | null = null;
	let lastThinkingLevel = "off";

	// ─── Event Listeners (external segment registration) ───────────────

	pi.events.on("pi-status:register", (data: unknown) => {
		const payload = data as RegisterPayload;
		if (!payload?.id || !payload?.render) return;
		segments.set(payload.id, {
			id: payload.id,
			priority: payload.priority ?? 50,
			render: payload.render,
		});
		refresh();
	});

	pi.events.on("pi-status:update", (data: unknown) => {
		const payload = data as UpdatePayload;
		if (!payload?.id) return;
		if (payload.render === null) {
			segments.delete(payload.id);
		} else {
			const existing = segments.get(payload.id);
			segments.set(payload.id, {
				id: payload.id,
				priority: existing?.priority ?? 50,
				render: payload.render,
			});
		}
		refresh();
	});

	// ─── Git / Worktree Detection ──────────────────────────────────────

	async function refreshGitBranch(): Promise<void> {
		try {
			const r = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 });
			gitBranch = r.code === 0 ? r.stdout.trim() || null : null;
		} catch {
			gitBranch = null;
		}
	}

	async function detectWorktree(): Promise<void> {
		try {
			const r = await pi.exec("git", ["worktree", "list", "--porcelain"], { timeout: 2000 });
			if (r.code !== 0) { worktreeWarning = null; return; }
			const entries = r.stdout.split("\n\n").filter(Boolean);
			if (entries.length <= 1) { worktreeWarning = null; return; }
			worktreeWarning = `⚠ ${entries.length} worktrees active — verify correct worktree before making changes.`;
		} catch {
			worktreeWarning = null;
		}
	}

	// ─── Built-in Segments ─────────────────────────────────────────────

	function registerBuiltinSegments(ctx: ExtensionContext): void {
		// Model
		segments.set("_model", {
			id: "_model",
			priority: 90,
			render: (theme) => theme.fg("muted", shortModel(ctx.model)),
		});

		// Token usage bar
		segments.set("_tokens", {
			id: "_tokens",
			priority: 80,
			render: (theme) => {
				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens ?? 0;
				const ctxWindow = ctx.model?.contextWindow ?? 200_000;
				const pct = ctxWindow > 0 ? tokens / ctxWindow : 0;
				const bar = buildBar(pct, 10, theme);
				const pctStr = `${Math.round(pct * 100)}%`;
				const tokenColor = pct >= 0.9 ? "error" : pct >= 0.6 ? "warning" : "dim";
				return `${bar} ${theme.fg(tokenColor, `${pctStr} ${fmt(tokens)}/${fmt(ctxWindow)}`)}`;
			},
		});

		// I/O tokens + cost
		segments.set("_io", {
			id: "_io",
			priority: 70,
			render: (theme) => {
				const stats = statsCache.sync(ctx);
				return theme.fg("dim", `↑${fmt(stats.input)} ↓${fmt(stats.output)}`) + " " + theme.fg("dim", `$${stats.cost.toFixed(2)}`);
			},
		});

		// Thinking level
		segments.set("_thinking", {
			id: "_thinking",
			priority: 60,
			render: (theme) => {
				const level = pi.getThinkingLevel();
				lastThinkingLevel = level;
				const color = THINKING_COLORS[level] ?? "dim";
				return theme.fg(color, `🧠 ${level}`);
			},
		});

		// Git branch
		segments.set("_branch", {
			id: "_branch",
			priority: 10,
			render: (theme) => gitBranch ? theme.fg("dim", `⎇ ${gitBranch}`) : "",
		});
	}

	// ─── Rendering ─────────────────────────────────────────────────────

	function refresh(): void {
		if (!latestCtx) return;
		const theme = latestCtx.ui.theme;
		const sep = theme.fg("dim", " │ ");

		const parts = [...segments.values()]
			.sort((a, b) => b.priority - a.priority)
			.map((seg) => seg.render(theme))
			.filter(Boolean);

		latestCtx.ui.setWidget("context-bar", [` ${parts.join(sep)}`]);
	}

	function updateTitle(ctx: ExtensionContext): void {
		const model = shortModel(ctx.model);
		const branch = gitBranch ? ` - ${gitBranch}` : "";
		// Mode segment provides mode name via title event if available
		const modeLabel = (segments.get("mode") as any)?._titleLabel ?? "";
		const modePrefix = modeLabel ? `${modeLabel} - ` : "";
		ctx.ui.setTitle(`pi - ${modePrefix}${model}${branch}`);
	}

	// ─── Footer ────────────────────────────────────────────────────────

	function setupFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const sep = theme.fg("dim", " │ ");
					const parts: string[] = [];
					parts.push(theme.fg("muted", ctx.cwd));
					parts.push(theme.fg("dim", "C-M-M") + theme.fg("muted", " mode"));
					parts.push(theme.fg("dim", "S-Tab") + theme.fg("muted", " think"));
					parts.push(theme.fg("dim", "C-L") + theme.fg("muted", " model"));

					for (const status of footerData.getExtensionStatuses().values()) {
						parts.push(status);
					}

					return [truncateToWidth(` ${parts.join(sep)}`, width)];
				},
			};
		});
	}

	// ─── LLM Environment Injection ─────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;
		const ctxWindow = ctx.model?.contextWindow ?? 200_000;
		const pct = ctxWindow > 0 ? Math.round((tokens / ctxWindow) * 100) : 0;

		const envLines: string[] = [];
		if (gitBranch) envLines.push(`Git branch: ${gitBranch}`);
		envLines.push(`Context: ${pct}% used (${fmt(tokens)}/${fmt(ctxWindow)} tokens)`);
		if (worktreeWarning) envLines.push(worktreeWarning);

		const envBlock = envLines.join("\n");
		return { systemPrompt: event.systemPrompt + "\n\n" + envBlock };
	});

	// ─── Lifecycle Events ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		statsCache.reset();
		await refreshGitBranch();
		await detectWorktree();
		registerBuiltinSegments(ctx);
		refresh();
		updateTitle(ctx);
		setupFooter(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		await refreshGitBranch();
		refresh();
		updateTitle(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		refresh();
		updateTitle(ctx);
	});

	// Listen for mode changes to update title
	pi.events.on("pi-modes:changed", (data: { mode: string; previousMode: string }) => {
		if (!latestCtx) return;
		updateTitle(latestCtx);
	});
}
