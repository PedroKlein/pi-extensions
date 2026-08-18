import { describe, expect, it } from "vitest";

import { EditorController, type EditorDeps } from "../src/editor.js";
import type { AliasesConfigRaw } from "../src/config.js";

function makeDeps(
	initial: AliasesConfigRaw,
	models: Record<string, string[]> = {},
): { deps: EditorDeps; written: AliasesConfigRaw[]; reloads: () => number } {
	const written: AliasesConfigRaw[] = [];
	let reloads = 0;
	const deps: EditorDeps = {
		aliasesPath: "/tmp/aliases.json",
		listModels: (b) => models[b] ?? [],
		listProviders: () => Object.keys(models),
		loadRaw: () => structuredClone(initial),
		writeConfig: (_p, raw) => {
			written.push(structuredClone(raw));
		},
		reload: () => {
			reloads++;
		},
	};
	return { deps, written, reloads: () => reloads };
}

/** Move the cursor to the first menu row whose label includes `substr`, activate. */
function open(ctrl: EditorController, substr: string): void {
	const labels = ctrl.menuLabels();
	const idx = labels.findIndex((l) => l.includes(substr));
	if (idx < 0) throw new Error(`no menu row matching '${substr}' in ${JSON.stringify(labels)}`);
	ctrl.listView.moveTo(idx);
	ctrl.activate();
}

describe("EditorController — tier model selection", () => {
	it("selecting models for a (backend,tier) and saving writes the exact ids + reloads", () => {
		const initial: AliasesConfigRaw = {
			fallbackChain: ["openrouter"],
			backends: { openrouter: { tiers: { heavy: ["a"] } } },
		};
		const { deps, written, reloads } = makeDeps(initial, { openrouter: ["a", "b", "c"] });
		const ctrl = new EditorController(deps);

		open(ctrl, "Backend: openrouter");
		open(ctrl, "heavy");
		// tier screen: "a" preselected. Add "b".
		expect(ctrl.isMultiSelect).toBe(true);
		expect(ctrl.listView.selected()).toEqual(["a"]);
		ctrl.listView.moveTo(1); // "b"
		ctrl.toggle();
		expect(ctrl.listView.selected()).toEqual(["a", "b"]);
		ctrl.activate(); // commit tier

		ctrl.save();
		expect(written).toHaveLength(1);
		expect(written[0].backends.openrouter.tiers.heavy).toEqual(["a", "b"]);
		expect(reloads()).toBe(1);
		expect(ctrl.dirty).toBe(false);
	});

	it("clearing all models removes the tier and blocks save if it empties the backend", () => {
		const initial: AliasesConfigRaw = {
			fallbackChain: ["openrouter"],
			backends: { openrouter: { tiers: { heavy: ["a"] } } },
		};
		const { deps, written } = makeDeps(initial, { openrouter: ["a"] });
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: openrouter");
		open(ctrl, "heavy");
		ctrl.toggle(); // deselect "a"
		ctrl.activate(); // commit → heavy removed → backend has no tiers
		ctrl.save();
		expect(written).toHaveLength(0); // invalid: backend with no tiers
		expect(ctrl.notice).toMatch(/cannot save/);
	});
});

describe("EditorController — backend CRUD + chain", () => {
	const initial: AliasesConfigRaw = {
		fallbackChain: ["openrouter", "copilot"],
		backends: {
			openrouter: { tiers: { heavy: ["a"] } },
			copilot: { tiers: { heavy: ["b"] } },
		},
	};

	it("renaming a backend updates fallbackChain references", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: openrouter");
		open(ctrl, "Rename");
		ctrl.textInput.set("or");
		ctrl.activate(); // commit rename
		ctrl.save();
		expect(Object.keys(written[0].backends)).toEqual(["or", "copilot"]);
		expect(written[0].fallbackChain).toEqual(["or", "copilot"]);
	});

	it("deleting a backend drops it from the chain", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: copilot");
		open(ctrl, "Delete backend");
		ctrl.save();
		expect(written[0].backends.copilot).toBeUndefined();
		expect(written[0].fallbackChain).toEqual(["openrouter"]);
	});

	it("adding a backend requires tiers before it can be saved", () => {
		const { deps, written } = makeDeps(initial, { groq: ["g1", "g2"] });
		const ctrl = new EditorController(deps);
		open(ctrl, "+ Add backend");
		ctrl.textInput.set("groq");
		ctrl.activate(); // creates backend + enters its screen
		expect(ctrl.currentDraft.backends.groq).toEqual({ tiers: {} });
		ctrl.save();
		expect(written).toHaveLength(0); // no tiers yet
		// add a tier then save succeeds
		open(ctrl, "heavy");
		ctrl.toggle(); // select g1
		ctrl.activate();
		ctrl.save();
		expect(written[0].backends.groq.tiers.heavy).toEqual(["g1"]);
	});

	it("editing the fallback chain: toggle membership + reorder", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Fallback chain");
		// seeded: [openrouter, copilot], both selected.
		expect(ctrl.listView.selected()).toEqual(["openrouter", "copilot"]);
		// reorder: move copilot (index 1) up.
		ctrl.listView.moveTo(1);
		ctrl.reorderUp();
		ctrl.activate(); // commit
		ctrl.save();
		expect(written[0].fallbackChain).toEqual(["copilot", "openrouter"]);
	});

	it("setting reset schedule via the preset picker", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: openrouter");
		open(ctrl, "Reset schedule");
		// options: [(none), utc-midnight, utc-monthly-1st, utc-hourly]
		ctrl.listView.moveTo(1); // utc-midnight
		ctrl.activate();
		ctrl.save();
		expect(written[0].backends.openrouter.resetSchedule).toBe("utc-midnight");
	});

	it("setting cap status codes via text input, rejecting bad values", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: openrouter");
		open(ctrl, "Cap status codes");
		ctrl.textInput.set("999999"); // out of range
		ctrl.activate();
		expect(ctrl.notice).toMatch(/integers 100/);
		ctrl.textInput.set("402, 429");
		ctrl.activate();
		ctrl.save();
		expect(written[0].backends.openrouter.capStatusCodes).toEqual([402, 429]);
	});
});

describe("EditorController — breadcrumb + navigation", () => {
	const initial: AliasesConfigRaw = {
		fallbackChain: ["openrouter"],
		backends: { openrouter: { tiers: { heavy: ["a"] } } },
	};

	it("reflects the current navigation path", () => {
		const { deps } = makeDeps(initial, { openrouter: ["a", "b"] });
		const ctrl = new EditorController(deps);
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit"]);
		open(ctrl, "Backend: openrouter");
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit", "openrouter"]);
		open(ctrl, "heavy");
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit", "openrouter", "heavy"]);
		ctrl.back();
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit", "openrouter"]);
		open(ctrl, "Reset schedule");
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit", "openrouter", "reset schedule"]);
	});

	it("chain screen breadcrumb", () => {
		const { deps } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Fallback chain");
		expect(ctrl.breadcrumb()).toEqual(["gateway", "edit", "fallback chain"]);
	});
});

describe("EditorController — unsaved-changes guard", () => {
	const initial: AliasesConfigRaw = {
		fallbackChain: ["openrouter"],
		backends: { openrouter: { tiers: { heavy: ["a"] } }, copilot: { tiers: { heavy: ["b"] } } },
	};

	it("exits immediately when there are no edits", () => {
		const { deps } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		ctrl.back(); // at home, not dirty
		expect(ctrl.exited).toBe(true);
	});

	it("prompts to confirm on unsaved changes; discard abandons the draft", () => {
		const { deps, written } = makeDeps(initial);
		const ctrl = new EditorController(deps);
		open(ctrl, "Backend: copilot");
		open(ctrl, "Delete backend"); // now dirty, back at home
		expect(ctrl.dirty).toBe(true);
		ctrl.back(); // home + dirty → confirm
		expect(ctrl.confirmingDiscard).toBe(true);
		expect(ctrl.exited).toBe(false);
		ctrl.confirmDiscard(false); // keep editing
		expect(ctrl.confirmingDiscard).toBe(false);
		expect(ctrl.exited).toBe(false);
		ctrl.back();
		ctrl.confirmDiscard(true); // discard
		expect(ctrl.exited).toBe(true);
		expect(written).toHaveLength(0); // nothing persisted
	});
});
