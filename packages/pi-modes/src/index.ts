/**
 * pi-modes — Slim mode enforcement extension.
 *
 * 5 modes: ask, brainstorm, plan, build, none.
 * Denylist tool gating, write filtering, mode prompts, Ctrl+Alt+M cycle,
 * build scope negotiation, mode persistence, event emission.
 *
 * NONE mode = raw Pi (zero injection, zero restrictions from this extension).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join, resolve, relative, extname, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Mode } from "./types.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const MODE_ORDER: Mode[] = ["ask", "brainstorm", "plan", "build", "none"];

export const MODE_LABELS: Record<Mode, { icon: string; label: string; color: "muted" | "warning" | "accent" | "success" | "dim" }> = {
	ask: { icon: "❓", label: "ASK", color: "muted" },
	brainstorm: { icon: "💡", label: "BRAINSTORM", color: "warning" },
	plan: { icon: "📋", label: "PLAN", color: "accent" },
	build: { icon: "🔨", label: "BUILD", color: "success" },
	none: { icon: "⊘", label: "NONE", color: "dim" },
};

/** Modes that deny full bash (use bash_readonly instead) */
export const READONLY_BASH_MODES: Set<Mode> = new Set(["ask", "brainstorm", "plan"]);

/** Modes that block mutating subagents */
export const RESTRICTED_SUBAGENT_MODES: Set<Mode> = new Set(["ask", "brainstorm", "plan"]);
export const BLOCKED_SUBAGENTS = new Set(["worker", "oracle-executor"]);

/** Modes that enforce write filtering (only allow markdown) */
export const WRITE_FILTERED_MODES: Set<Mode> = new Set(["ask", "brainstorm"]);
export const ALLOWED_WRITE_EXTENSIONS = new Set([".md", ".mdx"]);

/** Mode entry type for persistence */
const MODE_ENTRY_TYPE = "pi-mode";

// ─── Prompt Loading ────────────────────────────────────────────────────────

function loadModePrompts(): Record<Mode, string | null> {
	const prompts: Record<Mode, string | null> = {
		ask: null, brainstorm: null, plan: null, build: null, none: null,
	};
	const promptsDir = join(homedir(), ".pi", "agent", "extensions", "pi-modes", "prompts");
	for (const mode of MODE_ORDER) {
		if (mode === "none") continue; // none has no prompt
		try {
			const content = readFileSync(join(promptsDir, `${mode}.md`), "utf-8").trim();
			if (content) prompts[mode] = content;
		} catch { /* use null — no prompt fallback needed */ }
	}
	return prompts;
}

// ─── Write Filtering ───────────────────────────────────────────────────────

export function isWriteAllowed(inputPath: string, cwd: string): boolean {
	if (!inputPath) return false;
	const abs = resolve(cwd, inputPath);

	// 1. Markdown files inside cwd
	const rel = relative(resolve(cwd), abs);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
		if (ALLOWED_WRITE_EXTENSIONS.has(extname(abs).toLowerCase())) return true;
	}

	// 2. Anything under /tmp/ or OS tmpdir
	const tmp = tmpdir();
	if (abs.startsWith("/tmp/") || abs.startsWith(tmp + "/")) return true;

	// 3. Anything under ~/.pi/
	const piDir = join(homedir(), ".pi");
	if (abs.startsWith(piDir + "/")) return true;

	return false;
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function piModes(pi: ExtensionAPI): void {
	// Skip in subagent child processes
	if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) return;

	let currentMode: Mode = "ask";
	let modePrompts = loadModePrompts();
	let buildEntryDone = false;
	let latestCtx: ExtensionContext | null = null;

	// ─── Tool Gating ───────────────────────────────────────────────────

	function applyToolGating(): void {
		if (currentMode === "build" || currentMode === "none") {
			// Unrestricted — bash_readonly redundant when full bash available
			const allTools = pi.getAllTools().map((t) => t.name);
			const active = allTools.filter((t) => t !== "bash_readonly");
			pi.setActiveTools(active);
		} else {
			// Deny bash, replace with bash_readonly
			const allTools = pi.getAllTools().map((t) => t.name);
			const active = allTools.filter((t) => t !== "bash");
			pi.setActiveTools(active);
		}
	}

	// ─── Mode Switching ────────────────────────────────────────────────

	function applyMode(mode: Mode, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		const prevMode = currentMode;
		currentMode = mode;

		applyToolGating();

		if (mode === "build") {
			buildEntryDone = false;
		}

		if (options?.persist !== false) {
			pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		}

		if (options?.notify !== false && prevMode !== mode) {
			ctx.ui.notify(`Switched to ${MODE_LABELS[mode].label.toLowerCase()} mode`, "info");
		}

		// Emit mode change event for pi-status and other extensions
		pi.events.emit("pi-modes:changed", { mode, previousMode: prevMode });

		// Publish mode segment to pi-status
		const info = MODE_LABELS[mode];
		pi.events.emit("pi-status:register", {
			id: "mode",
			priority: 100,
			render: (theme: any) => theme.fg(info.color, `${info.icon} ${info.label}`),
		});
	}

	function cycleMode(ctx: ExtensionContext): void {
		const idx = MODE_ORDER.indexOf(currentMode);
		const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
		applyMode(next, ctx);
	}

	// ─── Mode Persistence ──────────────────────────────────────────────

	function getPersistedMode(ctx: ExtensionContext): Mode | null {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { mode?: Mode } };
			if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
				const mode = entry.data?.mode;
				if (mode && MODE_ORDER.includes(mode)) return mode;
			}
		}
		return null;
	}

	// ─── Shortcuts ─────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle workflow mode",
		handler: async (ctx) => cycleMode(ctx),
	});

	// ─── Tool Call Hook (write filtering + subagent gating) ────────────

	pi.on("tool_call", async (event, ctx) => {
		// Write filtering in ask/brainstorm
		if (WRITE_FILTERED_MODES.has(currentMode)) {
			if (event.toolName === "write" || event.toolName === "edit") {
				const inputPath = (event.input as { path?: string })?.path ?? "";
				if (!isWriteAllowed(inputPath, ctx.cwd)) {
					return {
						block: true,
						reason: `[${MODE_LABELS[currentMode].label} MODE] Write blocked for '${inputPath}'. ` +
							`In read-only modes, writes are limited to: markdown (.md/.mdx) in cwd, /tmp/, ~/.pi/. ` +
							`Cycle to build or none mode for unrestricted access.`,
					};
				}
			}
		}

		// Subagent gating in ask/brainstorm/plan
		if (RESTRICTED_SUBAGENT_MODES.has(currentMode) && event.toolName === "subagent") {
			const input = event.input as { agent?: string; tasks?: Array<{ agent: string }> };
			const agents = input.tasks?.map((t) => t.agent) ?? (input.agent ? [input.agent] : []);
			const blocked = agents.filter((a) => BLOCKED_SUBAGENTS.has(a));
			if (blocked.length > 0) {
				return {
					block: true,
					reason: `[${MODE_LABELS[currentMode].label} MODE] ${blocked.join(", ")} blocked (mutating agents). ` +
						`Cycle to build or none mode for full subagent access.`,
				};
			}
		}
	});

	// ─── System Prompt Injection ───────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		// None mode: zero injection
		if (currentMode === "none") return;

		let prompt = event.systemPrompt;

		// Inject mode prompt
		const modePrompt = modePrompts[currentMode];
		if (modePrompt) {
			prompt += "\n\n" + modePrompt;
		}

		// Build scope negotiation (first turn only)
		if (currentMode === "build" && !buildEntryDone) {
			buildEntryDone = true;

			if (ctx.hasUI) {
				try {
					const scopeLines: string[] = [];

					const scopeChoice = await ctx.ui.select(
						"Build scope:",
						["One task", "Multiple tasks", "Until I hit a problem"],
					);
					if (scopeChoice !== undefined) {
						scopeLines.push(`Scope: ${scopeChoice}`);
					}

					const handoffChoice = await ctx.ui.select(
						"Handoff format:",
						["Markdown in chat", "HTML report", "None"],
					);
					if (handoffChoice !== undefined) {
						scopeLines.push(`Handoff: ${handoffChoice}`);
					}

					if (scopeLines.length > 0) {
						prompt += "\n\n[BUILD SCOPE — confirmed]\n" + scopeLines.join("\n");
						prompt += "\nScope is already confirmed. Start working immediately — do NOT re-ask.";
					}
				} catch {
					// UI dismissed — let agent negotiate naturally
				}
			}
		}

		return { systemPrompt: prompt };
	});

	// ─── Lifecycle Events ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		modePrompts = loadModePrompts();
		buildEntryDone = false;

		const persisted = getPersistedMode(ctx);
		currentMode = persisted ?? "ask";

		applyMode(currentMode, ctx, { persist: false, notify: false });
	});

	// Listen for mode switch from pi-ask (ask_user action: mode-switch)
	let modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;

	pi.events.on("pi-ask:mode-switch", (data: { mode: string }) => {
		if (!latestCtx) return;
		const target = data.mode as Mode;
		if (!MODE_ORDER.includes(target)) return;
		if (target === currentMode) return;

		applyMode(target, latestCtx);
		latestCtx.abort();

		if (modeSwitchTimer) clearTimeout(modeSwitchTimer);
		modeSwitchTimer = setTimeout(() => {
			modeSwitchTimer = null;
			pi.sendUserMessage(
				`Continue working. Mode is now ${MODE_LABELS[target].label.toLowerCase()}.`,
				{ deliverAs: "followUp" },
			);
		}, 150);
	});

	// Filter mode persistence entries from LLM context
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => {
			return !(m.role === "custom" && m.customType === MODE_ENTRY_TYPE);
		});
		return { messages: filtered };
	});
}
