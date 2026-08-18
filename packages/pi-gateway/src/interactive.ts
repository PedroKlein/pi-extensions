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
import { loadAliasesConfig, loadAliasesConfigRaw, type AliasesConfig } from "./config.js";
import { writeAliasesConfig } from "./aliases-writer.js";
import { EditorController } from "./editor.js";
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
	/** Real model ids registered for a backend (provider), sorted + stable. */
	listModels: (backend: string) => string[];
	/** All provider names known to the registry, sorted. For add-backend. */
	listProviders: () => string[];
}

export interface GatewayModalOptions {
	/** Which pane to open on. Defaults to "main". */
	startMode?: "main" | "models";
}

type Mode = "main" | "force" | "toggle" | "reorder" | "models" | "editor";

/** Rows of the scrolling viewport used for editor lists. */
const EDITOR_VIEWPORT_ROWS = 14;

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
			let editor: EditorController | undefined;
			let showHelp = false;

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

			function enterEditor() {
				try {
					editor = new EditorController({
						aliasesPath: deps.aliasesPath,
						listModels: deps.listModels,
						listProviders: deps.listProviders,
						loadRaw: () => loadAliasesConfigRaw(deps.aliasesPath),
						writeConfig: (p, raw) => writeAliasesConfig(p, raw),
						reload: () => {
							void deps
								.rebuildController()
								.then(() => {
									aliases = tryLoadAliases();
									rerender();
								})
								.catch(() => {
									/* notice surfaced by controller */
								});
						},
					});
					mode = "editor";
				} catch (err) {
					notice = `editor unavailable: ${(err as Error).message}`;
				}
			}

			// ── Input ─────────────────────────────────────────────────────────

			function handleInput(data: string) {
				notice = undefined;
				// '?' toggles the help pane on any non-text-entry mode.
				if (data === "?" && mode !== "editor") {
					showHelp = !showHelp;
					rerender();
					return;
				}
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
					case "editor":
						handleEditor(data);
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
				if (data === "e") return enterEditor();
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

			function handleEditor(data: string) {
				const ed = editor;
				if (!ed) {
					mode = "main";
					return;
				}
				// Discard confirmation intercepts everything.
				if (ed.confirmingDiscard) {
					if (data === "y") ed.confirmDiscard(true);
					else if (data === "n" || matchesKey(data, "escape")) ed.confirmDiscard(false);
					if (ed.exited) leaveEditor();
					return;
				}

				if (matchesKey(data, "escape")) {
					ed.back();
					if (ed.exited) leaveEditor();
					return;
				}
				if (matchesKey(data, "enter")) {
					ed.activate();
					return;
				}
				if (matchesKey(data, "up")) return ed.moveUp();
				if (matchesKey(data, "down")) return ed.moveDown();

				if (ed.isInput) {
					if (matchesKey(data, "backspace") || data === "\x7f") return ed.backspace();
					ed.handleChar(data);
					return;
				}

				if (ed.filterable) {
					if (data === " ") return ed.toggle();
					if (data === "J") return ed.reorderDown();
					if (data === "K") return ed.reorderUp();
					if (matchesKey(data, "backspace") || data === "\x7f") return ed.backspace();
					ed.handleChar(data);
					return;
				}

				// Menu / preset screens: vim nav + save.
				if (data === "k") return ed.moveUp();
				if (data === "j") return ed.moveDown();
				if (data === "s") return ed.save();
			}

			function leaveEditor() {
				editor = undefined;
				mode = "main";
				aliases = tryLoadAliases();
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

				const inEditor = mode === "editor" && editor;
				const title = inEditor ? editor!.breadcrumb().join(" ▸ ") : titleFor(mode);
				const body = inEditor ? renderEditorBody(contentW) : bodyFor(mode, contentW);
				const hint = inEditor ? editor!.hint() : hintFor(mode);
				const activeNotice = inEditor ? (editor!.notice ?? notice) : notice;

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

				const rendered = showHelp ? helpLines() : body;
				for (const raw of rendered) {
					const fitted =
						visibleWidth(raw) > contentW ? truncateToWidth(raw, contentW) : pad(raw, contentW);
					lines.push(theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│"));
				}

				// Notice + hint.
				lines.push(rowLine("", contentW));
				if (activeNotice) {
					lines.push(rowLine(theme.fg("warning", "  " + activeNotice), contentW));
				}
				const hintText = showHelp ? "? close help · Esc back" : `${hint}${mode === "editor" ? "" : " · ? help"}`;
				lines.push(rowLine(theme.fg("dim", "  " + hintText), contentW));

				lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

				cachedLines = lines;
				return lines;
			}

			/** Help pane: full key list for the current mode. */
			function helpLines(): string[] {
				const common = [theme.fg("dim", "↑↓ / jk  move"), theme.fg("dim", "Esc      back / cancel")];
				if (mode === "editor" && editor) {
					return [
						theme.bold("Editor keys"),
						"",
						"Enter    open / commit",
						"Space    toggle selection (tiers / chain)",
						"Shift+JK reorder (chain)",
						"type     filter (pick lists) / edit text",
						"s        save aliases.json",
						"Esc      back (prompts if unsaved)",
					];
				}
				return [
					theme.bold("gateway keys"),
					"",
					"f  force backend       c  clear overrides",
					"v  view models         r  reorder chain",
					"m  toggle health       e  edit aliases.json",
					"R  reload              q  quit",
					"",
					...common,
				];
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

			function renderEditorBody(_contentW: number): string[] {
				const ed = editor!;
				const lines: string[] = [];

				if (ed.isInput) {
					const t = ed.textInput;
					const before = t.value.slice(0, t.caret);
					const after = t.value.slice(t.caret);
					lines.push("");
					lines.push("  " + before + theme.fg("accent", "▏") + after);
					return lines;
				}

				const lv = ed.listView;
				if (ed.filterable) {
					lines.push(theme.fg("dim", `filter: ${lv.filter || "—"}`));
					lines.push("");
				}
				const win = lv.window(EDITOR_VIEWPORT_ROWS);
				if (win.hasAbove) lines.push(theme.fg("dim", "  ↑ more…"));
				if (win.items.length === 0) {
					lines.push(theme.fg("dim", "  (nothing here)"));
				}
				win.items.forEach((item, i) => {
					const isCursor = i === win.cursorRow;
					const marker = isCursor ? theme.fg("accent", "▸ ") : "  ";
					let text = item;
					if (ed.isMultiSelect) {
						const on = lv.isSelected(item);
						text = (on ? theme.fg("success", "[×] ") : theme.fg("dim", "[ ] ")) + item;
					}
					lines.push(marker + (isCursor ? theme.fg("accent", theme.bold(text)) : text));
				});
				if (win.hasBelow) lines.push(theme.fg("dim", "  ↓ more…"));
				return lines;
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
					case "editor":
						return []; // editor renders via renderEditorBody()
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
		case "editor":
			return "gateway · edit";
	}
}

function hintFor(mode: Mode): string {
	switch (mode) {
		case "main":
			return "f force · c clear · v models · e edit · r reorder · m toggle · R reload · q quit";
		case "force":
			return "↑↓/jk move · Enter select · Esc back";
		case "toggle":
			return "↑↓/jk move · Enter toggle · Esc back";
		case "reorder":
			return "↑↓/jk move · Shift+J/K reorder · Enter commit · x reset · Esc cancel";
		case "models":
			return "Esc back";
		case "editor":
			return "↑↓ move · Enter open · s save · Esc back";
	}
}
