/**
 * pi-modes — Slim mode enforcement extension.
 *
 * 5 modes: ask, brainstorm, plan, build, none.
 * Denylist tool gating, write filtering, stable mode contracts,
 * Ctrl+Alt+M cycle, mode persistence, event emission.
 *
 * NONE mode = raw Pi (zero injection, zero restrictions from this extension).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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
	const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));
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

// ─── Skill Invocation Resolution ───────────────────────────────────────────

function regexEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function personalSkillNames(ctx: ExtensionContext): string[] {
	const root = resolve(homedir(), ".agents", "skills");
	const runtime = ctx as ExtensionContext & {
		getSystemPromptOptions?: () => {
			skills?: Array<{ name: string; filePath: string }>;
		};
	};
	const skills = runtime.getSystemPromptOptions?.().skills ?? [];
	const configured = skills.flatMap((skill) => {
		const path = resolve(skill.filePath);
		const rel = relative(root, path);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [skill.name] : [];
	});
	if (configured.length > 0) return configured;
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function invocationPattern(name: string): RegExp {
	return new RegExp(
		`\\b(?:use|load|apply|run|invoke)\\b\\s+(?:the\\s+)?(?:personal\\s+)?(?:skill\\s+)?${regexEscape(name)}(?:\\s+skill)?\\b`,
		"i",
	);
}

function negatedInvocationPattern(name: string): RegExp {
	return new RegExp(
		`(?:\\b(?:do\\s+not|don['’]?t|never|cannot|can['’]?t)\\s+(?:use|load|apply|run|invoke)|\\bwithout\\s+(?:using|loading|applying|running|invoking))\\s+(?:the\\s+)?(?:personal\\s+)?(?:skill\\s+)?${regexEscape(name)}(?:\\s+skill)?\\b`,
		"i",
	);
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function piModes(pi: ExtensionAPI): void {
	// Skip in subagent child processes
	if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) return;

	let currentMode: Mode = "ask";
	let modePrompts = loadModePrompts();
	let latestCtx: ExtensionContext | null = null;
	let pendingContinuationStartedAt: number | null = null;

	// ─── Tool Gating ───────────────────────────────────────────────────

	function applyToolGating(): void {
		if (currentMode === "none") {
			pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
		} else if (currentMode === "build") {
			// Full bash makes the read-only wrapper redundant in build mode.
			const allTools = pi.getAllTools().map((tool) => tool.name);
			pi.setActiveTools(allTools.filter((tool) => tool !== "bash_readonly"));
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

	for (const mode of MODE_ORDER) {
		pi.registerCommand(mode, {
			description: `Switch to ${MODE_LABELS[mode].label.toLowerCase()} mode`,
			handler: async (_args, ctx) => applyMode(mode, ctx),
		});
	}

	// ─── Exact-Name Personal Skill Resolution ─────────────────────────

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const mentioned = personalSkillNames(ctx).filter((name) =>
			new RegExp(`(?<![a-z0-9-])${regexEscape(name)}(?![a-z0-9-])`, "i").test(event.text),
		);
		if (mentioned.length > 1) {
			const requested = mentioned.some(
				(name) =>
					invocationPattern(name).test(event.text) &&
					!negatedInvocationPattern(name).test(event.text),
			);
			if (!requested) return;
			ctx.ui.notify(
				"Name one personal skill per request so Pi can expand it deterministically.",
				"warning",
			);
			return { action: "handled" };
		}
		if (mentioned.length !== 1) return;
		const [name] = mentioned;
		if (negatedInvocationPattern(name).test(event.text)) return;
		if (!invocationPattern(name).test(event.text)) return;
		return {
			action: "transform",
			text: `/skill:${name} ${event.text}`,
		};
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

	pi.on("before_agent_start", async (event) => {
		if (currentMode === "none") return;

		const modePrompt = modePrompts[currentMode];
		if (!modePrompt) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + modePrompt };
	});

	// ─── Lifecycle Events ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		modePrompts = loadModePrompts();

		const persisted = getPersistedMode(ctx);
		currentMode = persisted ?? "ask";

		applyMode(currentMode, ctx, { persist: false, notify: false });
	});

	// Listen for mode switch from pi-ask (ask_user action: mode-switch)
	let modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;

	pi.events.on("pi-ask:mode-switch", (data: unknown) => {
		if (!latestCtx || !data || typeof data !== "object") return;
		const target = (data as { mode?: string }).mode as Mode;
		if (!MODE_ORDER.includes(target)) return;
		if (target === currentMode) return;

		applyMode(target, latestCtx);
		latestCtx.abort();

		if (modeSwitchTimer) clearTimeout(modeSwitchTimer);
		modeSwitchTimer = setTimeout(() => {
			modeSwitchTimer = null;
			pendingContinuationStartedAt = Date.now();
			pi.sendUserMessage(
				`Continue working. Mode is now ${MODE_LABELS[target].label.toLowerCase()}.`,
				{ deliverAs: "followUp" },
			);
		}, 150);
	});

	pi.on("agent_end", (event, ctx) => {
		if (pendingContinuationStartedAt === null) return;
		const totals = {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			reasoning: 0,
		};
		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			totals.input += message.usage?.input ?? 0;
			totals.cacheRead += message.usage?.cacheRead ?? 0;
			totals.cacheWrite += message.usage?.cacheWrite ?? 0;
			totals.output += message.usage?.output ?? 0;
			totals.reasoning += message.usage?.reasoning ?? 0;
		}
		pi.events.emit("pi-audit:usage", {
			source: "pi-modes",
			operation: "mode-switch-continuation",
			model: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "unknown",
			...totals,
			durationMs: Date.now() - pendingContinuationStartedAt,
			trigger: "automatic",
			status: "complete",
		});
		pendingContinuationStartedAt = null;
	});

	// Filter mode persistence entries from LLM context
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => {
			return !(m.role === "custom" && m.customType === MODE_ENTRY_TYPE);
		});
		return { messages: filtered };
	});
}
