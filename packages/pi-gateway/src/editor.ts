/**
 * Editor state machine for the interactive aliases.json editor.
 *
 * Framework-agnostic: it owns the draft ({@link AliasesConfigRaw}), a navigation
 * stack of screens, and the active list/text widgets, exposing everything via
 * getters so the TUI component just renders + forwards keys. All draft edits go
 * through the pure {@link aliases-writer} helpers, so every change is reversible
 * until an explicit save (the draft is only persisted on {@link save}).
 *
 * This design keeps the hard logic testable without a terminal: drive it with
 * method calls and assert on the draft / written config.
 */

import {
	addBackend,
	cloneDraft,
	removeBackend,
	renameBackend,
	setCapStatusCodes,
	setFallbackChain,
	setQuotaHint,
	setResetSchedule,
	setTierModels,
	tierModels,
	validateDraft,
	writeAliasesConfig,
} from "./aliases-writer.js";
import {
	type AliasesConfigRaw,
	QUOTA_HINTS,
	RESET_SCHEDULES,
	type QuotaHint,
	type ResetSchedule,
	TIER_SLOTS,
	type TierSlot,
} from "./config.js";
import { isPrintableChar, ListView, TextInput } from "./tui-widgets.js";

export interface EditorDeps {
	aliasesPath: string;
	/** Real model ids for a backend (provider). */
	listModels: (backend: string) => string[];
	/** All provider names known to the registry. */
	listProviders: () => string[];
	/** Load the current aliases.json as a raw draft. */
	loadRaw: () => AliasesConfigRaw;
	/** Persist a validated draft (atomic). */
	writeConfig: (path: string, raw: AliasesConfigRaw) => void;
	/** Reload + re-register after a successful save. */
	reload: () => void;
	/** Optional clock/prompt hooks kept minimal for now. */
}

type Screen =
	| { kind: "home" }
	| { kind: "backend"; backend: string }
	| { kind: "tier"; backend: string; slot: TierSlot }
	| { kind: "chain" }
	| { kind: "preset"; backend: string; field: "reset" | "quota" }
	| { kind: "input"; purpose: "add-backend" | "rename-backend" | "cap-codes"; backend?: string };

interface MenuItem {
	label: string;
	run: () => void;
}

const NONE_LABEL = "(none)";

export class EditorController {
	private draft: AliasesConfigRaw;
	private _dirty = false;
	private stack: Screen[] = [{ kind: "home" }];
	private list = new ListView();
	private menu: MenuItem[] = [];
	private text = new TextInput();
	private _filterable = false;
	private _multiSelect = false;
	private _notice: string | undefined;
	private _confirmDiscard = false;
	private _exited = false;

	constructor(private readonly deps: EditorDeps) {
		this.draft = cloneDraft(deps.loadRaw());
		this.rebuild();
	}

	// ── Public getters (for rendering) ────────────────────────────────────

	get dirty(): boolean {
		return this._dirty;
	}

	get exited(): boolean {
		return this._exited;
	}

	get notice(): string | undefined {
		return this._notice;
	}

	get confirmingDiscard(): boolean {
		return this._confirmDiscard;
	}

	get screen(): Screen {
		return this.stack[this.stack.length - 1];
	}

	get isInput(): boolean {
		return this.screen.kind === "input";
	}

	get isMultiSelect(): boolean {
		return this._multiSelect;
	}

	get filterable(): boolean {
		return this._filterable;
	}

	get listView(): ListView {
		return this.list;
	}

	get textInput(): TextInput {
		return this.text;
	}

	/** A snapshot of the draft (for inspection/tests). */
	get currentDraft(): AliasesConfigRaw {
		return cloneDraft(this.draft);
	}

	/** Breadcrumb segments from root to the current screen. */
	breadcrumb(): string[] {
		const s = this.screen;
		const base = ["gateway", "edit"];
		switch (s.kind) {
			case "home":
				return base;
			case "backend":
				return [...base, s.backend];
			case "tier":
				return [...base, s.backend, s.slot];
			case "chain":
				return [...base, "fallback chain"];
			case "preset":
				return [...base, s.backend, s.field === "reset" ? "reset schedule" : "quota hint"];
			case "input":
				return [...base, s.purpose];
		}
	}

	/** Per-screen key hint. */
	hint(): string {
		if (this._confirmDiscard) return "unsaved changes — y discard · n keep editing";
		const s = this.screen;
		switch (s.kind) {
			case "home":
				return "↑↓ move · Enter open · s save · Esc back";
			case "backend":
				return "↑↓ move · Enter edit/toggle · s save · Esc back";
			case "tier":
				return "↑↓ move · Space toggle · type to filter · Enter commit · Esc cancel";
			case "chain":
				return "↑↓ move · Space add/remove · Shift+J/K reorder · Enter commit · Esc cancel";
			case "preset":
				return "↑↓ move · Enter select · Esc back";
			case "input":
				return "type · Enter commit · Esc cancel";
		}
	}

	/** Menu labels for the current list screen (for non-widget rendering). */
	menuLabels(): string[] {
		return this.menu.map((m) => m.label);
	}

	// ── Input handling ────────────────────────────────────────────────────

	moveUp(): void {
		this.list.move(-1);
	}

	moveDown(): void {
		this.list.move(1);
	}

	/** Enter / activate the current row. */
	activate(): void {
		this._notice = undefined;
		const s = this.screen;
		if (s.kind === "input") {
			this.commitInput();
			return;
		}
		if (s.kind === "preset") {
			this.commitPreset();
			return;
		}
		if (s.kind === "tier") {
			this.commitTier();
			return;
		}
		if (s.kind === "chain") {
			this.commitChain();
			return;
		}
		// Menu screens (home, backend): run the selected item.
		const item = this.menu[this.list.cursor];
		item?.run();
	}

	/** Space — toggle selection on multi-select screens. */
	toggle(): void {
		if (!this._multiSelect) return;
		this.list.toggleSelected();
	}

	/** Type a printable character: filter (pick screens) or text (input). */
	handleChar(ch: string): void {
		if (!isPrintableChar(ch)) return;
		if (this.screen.kind === "input") {
			this.text.insert(ch);
		} else if (this._filterable) {
			this.list.appendFilter(ch);
		}
	}

	backspace(): void {
		if (this.screen.kind === "input") this.text.backspace();
		else if (this._filterable) this.list.backspaceFilter();
	}

	/** Shift+K — move the current chain item up. */
	reorderUp(): void {
		if (this.screen.kind !== "chain") return;
		const i = this.list.cursor;
		const items = this.list.filtered();
		if (i > 0) {
			const arr = [...items];
			[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
			this.list.setItems(arr);
			this.list.moveTo(i - 1);
		}
	}

	/** Shift+J — move the current chain item down. */
	reorderDown(): void {
		if (this.screen.kind !== "chain") return;
		const i = this.list.cursor;
		const items = this.list.filtered();
		if (i < items.length - 1) {
			const arr = [...items];
			[arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
			this.list.setItems(arr);
			this.list.moveTo(i + 1);
		}
	}

	/** Esc / back. Returns to the previous screen, or exits at home. */
	back(): void {
		this._notice = undefined;
		if (this._confirmDiscard) {
			// Answered elsewhere (y/n); Esc cancels the discard prompt.
			this._confirmDiscard = false;
			return;
		}
		if (this.stack.length > 1) {
			this.stack.pop();
			this.rebuild();
			return;
		}
		// At home: exit the editor (guard unsaved changes).
		if (this._dirty) {
			this._confirmDiscard = true;
			return;
		}
		this._exited = true;
	}

	/** Answer the discard prompt. */
	confirmDiscard(discard: boolean): void {
		if (!this._confirmDiscard) return;
		this._confirmDiscard = false;
		if (discard) this._exited = true;
	}

	/** 's' — validate + persist the draft. */
	save(): void {
		const validation = validateDraft(this.draft);
		if (!validation.ok) {
			this._notice = `cannot save: ${validation.message}`;
			return;
		}
		try {
			this.deps.writeConfig(this.deps.aliasesPath, this.draft);
			this.deps.reload();
			this._dirty = false;
			this._notice = "saved aliases.json";
		} catch (err) {
			this._notice = `save failed: ${(err as Error).message}`;
		}
	}

	// ── Screen entry ────────────────────────────────────────────────────────

	private push(screen: Screen): void {
		this.stack.push(screen);
		this.rebuild();
	}

	/** Rebuild list/menu/text for the current screen. */
	private rebuild(): void {
		const s = this.screen;
		this._filterable = false;
		this._multiSelect = false;
		this.menu = [];
		switch (s.kind) {
			case "home":
				this.buildHome();
				break;
			case "backend":
				this.buildBackend(s.backend);
				break;
			case "tier":
				this.buildTier(s.backend, s.slot);
				break;
			case "chain":
				this.buildChain();
				break;
			case "preset":
				this.buildPreset(s.backend, s.field);
				break;
			case "input":
				this.buildInput(s);
				break;
		}
	}

	private buildHome(): void {
		const names = Object.keys(this.draft.backends);
		this.menu = [
			{ label: "Fallback chain", run: () => this.push({ kind: "chain" }) },
			...names.map((name) => ({
				label: `Backend: ${name}`,
				run: () => this.push({ kind: "backend", backend: name }),
			})),
			{ label: "+ Add backend", run: () => this.push({ kind: "input", purpose: "add-backend" }) },
		];
		this.list = new ListView(this.menuLabels());
	}

	private buildBackend(name: string): void {
		const b = this.draft.backends[name];
		if (!b) {
			// Backend was removed under us — pop back.
			this.stack.pop();
			this.rebuild();
			return;
		}
		const reset = b.resetSchedule ?? NONE_LABEL;
		const quota = b.quotaHint ?? NONE_LABEL;
		const caps = b.capStatusCodes && b.capStatusCodes.length > 0 ? b.capStatusCodes.join(", ") : "default (402, 429)";
		this.menu = [
			{ label: `Rename (${name})`, run: () => this.enterRename(name) },
			{ label: `Reset schedule: ${reset}`, run: () => this.push({ kind: "preset", backend: name, field: "reset" }) },
			{ label: `Quota hint: ${quota}`, run: () => this.push({ kind: "preset", backend: name, field: "quota" }) },
			{ label: `Cap status codes: ${caps}`, run: () => this.enterCapCodes(name) },
		];
		for (const slot of TIER_SLOTS) {
			const models = tierModels(b, slot);
			const summary = models.length === 0 ? "(none)" : `${models.length}: ${models.join(", ")}`;
			this.menu.push({
				label: `  ${slot}: ${summary}`,
				run: () => this.push({ kind: "tier", backend: name, slot }),
			});
		}
		this.menu.push({ label: "Delete backend", run: () => this.deleteBackend(name) });
		this.list = new ListView(this.menuLabels());
	}

	private buildTier(name: string, slot: TierSlot): void {
		const available = this.deps.listModels(name);
		const current = tierModels(this.draft.backends[name], slot);
		// Include any currently-selected models even if the registry no longer
		// lists them, so the user can see + keep or remove stale entries.
		const items = [...new Set([...available, ...current])];
		this._filterable = true;
		this._multiSelect = true;
		this.list = new ListView(items, { selected: current });
	}

	private buildChain(): void {
		// Chain screen shows all backends; selection = membership; order = list
		// order for selected. Seed items as: current chain first, then the rest.
		const all = Object.keys(this.draft.backends);
		const chain = this.draft.fallbackChain.filter((n) => all.includes(n));
		const rest = all.filter((n) => !chain.includes(n));
		this._filterable = true;
		this._multiSelect = true;
		this.list = new ListView([...chain, ...rest], { selected: chain });
	}

	private buildPreset(name: string, field: "reset" | "quota"): void {
		const options = field === "reset" ? [NONE_LABEL, ...RESET_SCHEDULES] : [NONE_LABEL, ...QUOTA_HINTS];
		this._filterable = false;
		this.list = new ListView(options);
		const cur = field === "reset" ? this.draft.backends[name]?.resetSchedule : this.draft.backends[name]?.quotaHint;
		const idx = cur ? options.indexOf(cur) : 0;
		this.list.moveTo(idx < 0 ? 0 : idx);
	}

	private buildInput(s: Extract<Screen, { kind: "input" }>): void {
		if (s.purpose === "rename-backend" && s.backend) this.text = new TextInput(s.backend);
		else if (s.purpose === "cap-codes" && s.backend) {
			const caps = this.draft.backends[s.backend]?.capStatusCodes ?? [];
			this.text = new TextInput(caps.join(", "));
		} else this.text = new TextInput("");
	}

	// ── Commit handlers ──────────────────────────────────────────────────

	private enterRename(name: string): void {
		this.push({ kind: "input", purpose: "rename-backend", backend: name });
	}

	private enterCapCodes(name: string): void {
		this.push({ kind: "input", purpose: "cap-codes", backend: name });
	}

	private deleteBackend(name: string): void {
		this.draft = removeBackend(this.draft, name);
		this._dirty = true;
		this._notice = `deleted backend '${name}' (unsaved)`;
		this.stack.pop(); // back to home
		this.rebuild();
	}

	private commitInput(): void {
		const s = this.screen;
		if (s.kind !== "input") return;
		const value = this.text.value.trim();
		if (s.purpose === "add-backend") {
			if (value === "") {
				this._notice = "backend name required";
				return;
			}
			if (value in this.draft.backends) {
				this._notice = `backend '${value}' already exists`;
				return;
			}
			this.draft = addBackend(this.draft, value);
			this._dirty = true;
			this.stack.pop();
			this.rebuild();
			// Jump straight into the new backend.
			this.push({ kind: "backend", backend: value });
			this._notice = `added backend '${value}' — add tiers, then save`;
			return;
		}
		if (s.purpose === "rename-backend" && s.backend) {
			if (value === "" || value === s.backend) {
				this.stack.pop();
				this.rebuild();
				return;
			}
			if (value in this.draft.backends) {
				this._notice = `backend '${value}' already exists`;
				return;
			}
			this.draft = renameBackend(this.draft, s.backend, value);
			this._dirty = true;
			// Replace the underlying backend screen's name.
			this.stack.pop(); // input
			this.stack.pop(); // old backend screen
			this.rebuild();
			this.push({ kind: "backend", backend: value });
			this._notice = `renamed to '${value}' (unsaved)`;
			return;
		}
		if (s.purpose === "cap-codes" && s.backend) {
			if (value === "") {
				this.draft = setCapStatusCodes(this.draft, s.backend, undefined);
			} else {
				const codes = value.split(/[,\s]+/).filter(Boolean).map((t) => Number(t));
				if (codes.some((c) => !Number.isInteger(c) || c < 100 || c > 599)) {
					this._notice = "cap codes must be integers 100–599, comma-separated";
					return;
				}
				this.draft = setCapStatusCodes(this.draft, s.backend, codes);
			}
			this._dirty = true;
			this.stack.pop();
			this.rebuild();
			this._notice = "updated cap status codes (unsaved)";
		}
	}

	private commitPreset(): void {
		const s = this.screen;
		if (s.kind !== "preset") return;
		const choice = this.list.current();
		if (choice === undefined) return;
		const value = choice === NONE_LABEL ? undefined : choice;
		if (s.field === "reset") {
			this.draft = setResetSchedule(this.draft, s.backend, value as ResetSchedule | undefined);
		} else {
			this.draft = setQuotaHint(this.draft, s.backend, value as QuotaHint | undefined);
		}
		this._dirty = true;
		this.stack.pop();
		this.rebuild();
		this._notice = `set ${s.field === "reset" ? "reset schedule" : "quota hint"} (unsaved)`;
	}

	private commitTier(): void {
		const s = this.screen;
		if (s.kind !== "tier") return;
		const selected = this.list.selected();
		this.draft = setTierModels(this.draft, s.backend, s.slot, selected);
		this._dirty = true;
		this.stack.pop();
		this.rebuild();
		this._notice = `set ${s.slot} → ${selected.length} model(s) (unsaved)`;
	}

	private commitChain(): void {
		const s = this.screen;
		if (s.kind !== "chain") return;
		// Order = current filtered list order; membership = selected set,
		// preserving that display order.
		const order = this.list.filtered();
		const selected = new Set(this.list.selected());
		const chain = order.filter((n) => selected.has(n));
		this.draft = setFallbackChain(this.draft, chain);
		this._dirty = true;
		this.stack.pop();
		this.rebuild();
		this._notice = `set fallback chain (${chain.length}) — unsaved`;
	}
}
