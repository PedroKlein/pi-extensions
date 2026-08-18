/**
 * Interactive /gateway board — the follow-up to v1's text-only status view.
 *
 * Renders a centered overlay via `ctx.ui.custom()` whose footer keys actually
 * work. It never owns business logic: every mutation goes through the pure
 * `actions.ts` helpers + the atomic `updateState` writer, then asks the
 * controller to reload state and re-register the gateway provider. Rendering
 * reuses the pure `status-view.ts` composers so the interactive and text UIs
 * always agree on what an alias points at.
 *
 * Sub-modes (single component, no nested overlays — keeps input ownership
 * simple and disposal trivial):
 *
 *   main     — status board; keys open the other modes
 *   force    — pick a backend to pin (activeBackendOverride); "(none)" clears
 *   toggle   — pick a backend to flip healthy/unhealthy
 *   reorder  — reorder the effective fallback chain (fallbackChainOverride)
 *   models   — alias → provider → real model → status table
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { setActiveOverride, setFallbackChainOverride, toggleBackendHealth } from "./actions.js";
import { loadAliasesConfig, type AliasesConfig } from "./config.js";
import { isBackendUnhealthy } from "./compose.js";
import type { GatewayController } from "./controller.js";
import { nextResetInstant } from "./reset-schedule.js";
import {
	renderModelsRows,
	renderStatusSections,
	type StatusRenderInput,
} from "./status-view.js";
import { updateState, type GatewayState } from "./state.js";

export interface GatewayModalDeps {
	getController: () => GatewayController | undefined;
	statePath: string;
	aliasesPath: string;
	/** Rebuild the controller after reload; called by the reload key. */
	rebuildController: () => Promise<void>;
}

export interface GatewayModalOptions {
	/** Which pane to open on. Defaults to "main". */
	startMode?: "main" | "models";
}

type Mode = "main" | "force" | "toggle" | "reorder" | "models";

const CLEAR_OVERRIDE_LABEL = "(none — clear active override)";

/**
 * Show the interactive gateway board. Resolves when the user quits.
 *
 * Callers must guard on `ctx.hasUI && typeof ctx.ui.custom === "function"`;
 * this function assumes an interactive TUI is available.
 */
export async function showGatewayModal(
	ctx: ExtensionCommandContext,
	deps: GatewayModalDeps,
	options: GatewayModalOptions = {},
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let mode: Mode = options.startMode ?? "main";
			const startedInModels = mode === "models";
			let cursor = 0;
			let chainDraft: string[] = [];
			let notice: string | undefined;
			let cachedLines: string[] | undefined;

			// Loaded once and refreshed on reload; state is always read live from
			// the controller so mutations are reflected immediately.
			let aliases: AliasesConfig | undefined = tryLoadAliases();

			function tryLoadAliases(): AliasesConfig | undefined {
				try {
					return loadAliasesConfig(deps.aliasesPath);
				} catch (err) {
					notice = `aliases.json error: ${(err as Error).message}`;
					return undefined;
				}
			}

			function state(): GatewayState | undefined {
				return deps.getController()?.getState();
			}

			function invalidate() {
				cachedLines = undefined;
			}

			function rerender() {
				invalidate();
				tui.requestRender();
			}

			/** Backend names in stable config order. */
			function backendNames(): string[] {
				return aliases ? Object.keys(aliases.backends) : [];
			}

			/** Effective fallback chain honoring the state override. */
			function effectiveChain(): string[] {
				const s = state();
				if (!aliases) return [];
				return [...(s?.fallbackChainOverride ?? aliases.fallbackChain)];
			}

			/** Run a state mutation, persist atomically, reload + re-register. */
			function mutate(fn: (cur: GatewayState) => GatewayState): boolean {
				const controller = deps.getController();
				if (!controller) {
					notice = "gateway: controller unavailable";
					return false;
				}
				try {
					updateState(deps.statePath, fn);
					controller.reloadStateFromDisk();
					return true;
				} catch (err) {
					notice = `error: ${(err as Error).message}`;
					return false;
				}
			}

			// ── Mode entry helpers ────────────────────────────────────────────

			function enterForce() {
				cursor = 0;
				mode = "force";
			}

			function enterToggle() {
				cursor = 0;
				mode = "toggle";
			}

			function enterReorder() {
				chainDraft = effectiveChain();
				cursor = 0;
				mode = "reorder";
			}

			// ── Input ─────────────────────────────────────────────────────────

			function handleInput(data: string) {
				notice = undefined;
				switch (mode) {
					case "main":
						handleMain(data);
						break;
					case "force":
						handleForce(data);
						break;
					case "toggle":
						handleToggle(data);
						break;
					case "reorder":
						handleReorder(data);
						break;
					case "models":
						handleModels(data);
						break;
				}
				rerender();
			}

			function handleMain(data: string) {
				if (matchesKey(data, "escape") || data === "q") {
					done(undefined);
					return;
				}
				if (data === "f") return enterForce();
				if (data === "m") return enterToggle();
				if (data === "r") return enterReorder();
				if (data === "v") {
					mode = "models";
					return;
				}
				if (data === "c") {
					if (mutate((cur) => ({
						...cur,
						activeBackendOverride: undefined,
						fallbackChainOverride: undefined,
					}))) {
						notice = "cleared all overrides";
					}
					return;
				}
				if (data === "R") {
					void deps
						.rebuildController()
						.then(() => {
							aliases = tryLoadAliases();
							notice = "reloaded aliases.json + state.json";
							rerender();
						})
						.catch((err: unknown) => {
							notice = `reload failed: ${(err as Error).message}`;
							rerender();
						});
					return;
				}
			}

			function forceOptions(): string[] {
				return [CLEAR_OVERRIDE_LABEL, ...backendNames()];
			}

			function handleForce(data: string) {
				const opts = forceOptions();
				if (matchesKey(data, "escape")) {
					mode = "main";
					return;
				}
				if (moveCursor(data, opts.length)) return;
				if (matchesKey(data, "enter")) {
					if (!aliases) {
						mode = "main";
						return;
					}
					const target = cursor === 0 ? undefined : opts[cursor];
					if (mutate((cur) => {
						const r = setActiveOverride(cur, aliases!, target);
						return r.kind === "state-updated" ? r.nextState : cur;
					})) {
						notice = target ? `forced active backend → ${target}` : "cleared active override";
					}
					mode = "main";
				}
			}

			function handleToggle(data: string) {
				const names = backendNames();
				if (matchesKey(data, "escape") || data === "q") {
					mode = "main";
					return;
				}
				if (moveCursor(data, names.length)) return;
				if (matchesKey(data, "enter")) {
					if (!aliases || names.length === 0) {
						mode = "main";
						return;
					}
					const name = names[cursor];
					const until = nextResetInstant(aliases.backends[name].resetSchedule, new Date());
					if (mutate((cur) => {
						const r = toggleBackendHealth(cur, aliases!, name, until);
						return r.kind === "state-updated" ? r.nextState : cur;
					})) {
						notice = `toggled ${name} health`;
					}
					// Stay in toggle mode so several backends can be flipped in a row.
				}
			}

			function handleReorder(data: string) {
				if (matchesKey(data, "escape")) {
					mode = "main";
					return;
				}
				if (chainDraft.length === 0) {
					if (matchesKey(data, "enter") || data === "x") mode = "main";
					return;
				}
				// Move item up/down with Shift+J/K (uppercase).
				if (data === "K" && cursor > 0) {
					[chainDraft[cursor - 1], chainDraft[cursor]] = [chainDraft[cursor], chainDraft[cursor - 1]];
					cursor--;
					return;
				}
				if (data === "J" && cursor < chainDraft.length - 1) {
					[chainDraft[cursor + 1], chainDraft[cursor]] = [chainDraft[cursor], chainDraft[cursor + 1]];
					cursor++;
					return;
				}
				if (moveCursor(data, chainDraft.length)) return;
				if (data === "x") {
					// Reset to the config default (clear the chain override).
					if (mutate((cur) => ({ ...cur, fallbackChainOverride: undefined }))) {
						notice = "reset fallback chain to config default";
					}
					mode = "main";
					return;
				}
				if (matchesKey(data, "enter")) {
					if (!aliases) {
						mode = "main";
						return;
					}
					if (mutate((cur) => {
						const r = setFallbackChainOverride(cur, aliases!, [...chainDraft]);
						return r.kind === "state-updated" ? r.nextState : cur;
					})) {
						notice = `fallback chain → ${chainDraft.join(" → ")}`;
					}
					mode = "main";
				}
			}

			function handleModels(data: string) {
				if (matchesKey(data, "escape") || data === "q") {
					if (startedInModels) done(undefined);
					else mode = "main";
				}
			}

			/** Shared j/k + arrow cursor movement. Returns true if it consumed the key. */
			function moveCursor(data: string, length: number): boolean {
				if (length === 0) return false;
				if (matchesKey(data, "up") || data === "k") {
					cursor = (cursor - 1 + length) % length;
					return true;
				}
				if (matchesKey(data, "down") || data === "j") {
					cursor = (cursor + 1) % length;
					return true;
				}
				return false;
			}

			// ── Rendering ──────────────────────────────────────────────────────

			function pad(s: string, len: number): string {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, len - vis));
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;
				const contentW = Math.max(10, width - 4);

				const title = titleFor(mode);
				const body = bodyFor(mode, contentW);
				const hint = hintFor(mode);

				const lines: string[] = [];
				// Top border with title.
				const titleText = ` ${title} `;
				const titleLen = visibleWidth(titleText);
				const rightDash = Math.max(1, width - 2 - titleLen - 1);
				lines.push(
					theme.fg("accent", "╭─") +
						theme.fg("accent", theme.bold(titleText)) +
						theme.fg("accent", "─".repeat(rightDash) + "╮"),
				);

				for (const raw of body) {
					const fitted =
						visibleWidth(raw) > contentW ? truncateToWidth(raw, contentW) : pad(raw, contentW);
					lines.push(theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│"));
				}

				// Notice + hint.
				lines.push(rowLine("", contentW));
				if (notice) {
					lines.push(rowLine(theme.fg("warning", "  " + notice), contentW));
				}
				lines.push(rowLine(theme.fg("dim", "  " + hint), contentW));

				lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

				cachedLines = lines;
				return lines;
			}

			function rowLine(content: string, contentW: number): string {
				const fitted =
					visibleWidth(content) > contentW ? truncateToWidth(content, contentW) : pad(content, contentW);
				return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
			}

			function statusInput(): StatusRenderInput | undefined {
				const s = state();
				if (!aliases || !s) return undefined;
				return { aliases, state: s };
			}

			function bodyFor(m: Mode, _contentW: number): string[] {
				const input = statusInput();
				if (!input) {
					return [theme.fg("error", "gateway inactive — aliases.json missing or invalid")];
				}
				switch (m) {
					case "main":
						return mainBody(input);
					case "force":
						return listBody(
							forceOptions().map((label, i) => {
								if (i === 0) return label;
								const unhealthy = isBackendUnhealthy(label, input.state, new Date());
								return `${label}${unhealthy ? theme.fg("dim", " (unhealthy)") : ""}`;
							}),
							input.state.activeBackendOverride
								? indexOfBackend(input.state.activeBackendOverride)
								: 0,
						);
					case "toggle":
						return listBody(
							backendNames().map((name) => {
								const unhealthy = isBackendUnhealthy(name, input.state, new Date());
								return `${name.padEnd(20)} ${
									unhealthy ? theme.fg("warning", "unhealthy") : theme.fg("dim", "healthy")
								}`;
							}),
						);
					case "reorder":
						return listBody(
							chainDraft.length > 0
								? chainDraft
								: [theme.fg("dim", "(no chain — nothing to reorder)")],
						);
					case "models":
						return renderModelsRows(input);
				}
			}

			function mainBody(input: StatusRenderInput): string[] {
				const s = renderStatusSections(input);
				return [
					...s.header,
					"",
					theme.fg("dim", "Backends"),
					...s.backends,
					"",
					theme.fg("dim", "Aliases"),
					...s.aliases,
				];
			}

			function listBody(items: string[], activeIndex?: number): string[] {
				return items.map((item, i) => {
					const selected = i === cursor;
					const marker = selected ? theme.fg("accent", "▸ ") : "  ";
					const active = activeIndex !== undefined && i === activeIndex ? theme.fg("dim", " ●") : "";
					const text = selected ? theme.fg("accent", theme.bold(item)) : item;
					return marker + text + active;
				});
			}

			function indexOfBackend(name: string): number {
				const idx = backendNames().indexOf(name);
				return idx < 0 ? 0 : idx + 1; // +1 accounts for the "(none)" row.
			}

			return { render, invalidate, handleInput };
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as never,
				width: "70%",
				minWidth: 64,
				maxHeight: "85%",
			},
		},
	);
}

function titleFor(mode: Mode): string {
	switch (mode) {
		case "main":
			return "⚡ gateway";
		case "force":
			return "gateway · force backend";
		case "toggle":
			return "gateway · toggle backend health";
		case "reorder":
			return "gateway · reorder fallback chain";
		case "models":
			return "gateway · models";
	}
}

function hintFor(mode: Mode): string {
	switch (mode) {
		case "main":
			return "f force · c clear · v models · r reorder · m toggle · R reload · q quit";
		case "force":
			return "↑↓/jk move · Enter select · Esc back";
		case "toggle":
			return "↑↓/jk move · Enter toggle · Esc back";
		case "reorder":
			return "↑↓/jk move · Shift+J/K reorder · Enter commit · x reset · Esc cancel";
		case "models":
			return "Esc back";
	}
}
