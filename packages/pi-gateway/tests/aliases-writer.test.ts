import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAliasesConfigRaw, type AliasesConfigRaw } from "../src/config.js";
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
} from "../src/aliases-writer.js";

function sample(): AliasesConfigRaw {
	return {
		fallbackChain: ["openrouter", "copilot"],
		backends: {
			openrouter: {
				resetSchedule: "utc-midnight",
				// single-string tier — must round-trip as a string
				tiers: { heavy: ["or-heavy-1", "or-heavy-2"], light: "or-light" },
				capStatusCodes: [402],
			},
			copilot: {
				tiers: { heavy: "cop-heavy" },
			},
		},
	};
}

describe("loadAliasesConfigRaw", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gw-raw-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("preserves the file's raw shape (single-string tiers, omitted optionals)", () => {
		const p = join(dir, "aliases.json");
		writeFileSync(p, JSON.stringify(sample()));
		const raw = loadAliasesConfigRaw(p);
		expect(raw.backends.openrouter.tiers.light).toBe("or-light"); // still a string
		expect(raw.backends.copilot.resetSchedule).toBeUndefined(); // absent, not defaulted
		expect(raw.backends.copilot.capStatusCodes).toBeUndefined();
	});

	it("throws a schema error (not normalized) on an invalid file", () => {
		const p = join(dir, "aliases.json");
		writeFileSync(p, JSON.stringify({ fallbackChain: [], backends: {} }));
		expect(() => loadAliasesConfigRaw(p)).toThrow(/schema error/);
	});
});

describe("edit helpers — purity + behavior", () => {
	it("addBackend adds an empty backend and does not mutate input", () => {
		const before = sample();
		const snapshot = structuredClone(before);
		const after = addBackend(before, "groq");
		expect(before).toEqual(snapshot); // unchanged
		expect(after.backends.groq).toEqual({ tiers: {} });
		// no-op when it already exists
		expect(addBackend(after, "groq")).toBe(after);
	});

	it("removeBackend drops the backend and its chain reference", () => {
		const after = removeBackend(sample(), "copilot");
		expect(after.backends.copilot).toBeUndefined();
		expect(after.fallbackChain).toEqual(["openrouter"]);
	});

	it("renameBackend preserves key order and rewrites chain references", () => {
		const after = renameBackend(sample(), "openrouter", "or");
		expect(Object.keys(after.backends)).toEqual(["or", "copilot"]);
		expect(after.fallbackChain).toEqual(["or", "copilot"]);
		expect(after.backends.or.tiers.heavy).toEqual(["or-heavy-1", "or-heavy-2"]);
		// no-op when target already exists
		expect(renameBackend(after, "or", "copilot")).toBe(after);
	});

	it("setResetSchedule / setQuotaHint set and clear", () => {
		let r = setResetSchedule(sample(), "copilot", "utc-hourly");
		expect(r.backends.copilot.resetSchedule).toBe("utc-hourly");
		r = setResetSchedule(r, "copilot", undefined);
		expect(r.backends.copilot.resetSchedule).toBeUndefined();

		r = setQuotaHint(r, "openrouter", "daily-eur-cap");
		expect(r.backends.openrouter.quotaHint).toBe("daily-eur-cap");
		r = setQuotaHint(r, "openrouter", undefined);
		expect(r.backends.openrouter.quotaHint).toBeUndefined();
	});

	it("setCapStatusCodes sets a list and clears on empty/undefined", () => {
		let r = setCapStatusCodes(sample(), "copilot", [402, 429]);
		expect(r.backends.copilot.capStatusCodes).toEqual([402, 429]);
		r = setCapStatusCodes(r, "copilot", []);
		expect(r.backends.copilot.capStatusCodes).toBeUndefined();
	});

	it("setTierModels sets an ordered list and removes the slot when empty", () => {
		let r = setTierModels(sample(), "copilot", "medium", ["cop-med-1", "cop-med-2"]);
		expect(r.backends.copilot.tiers.medium).toEqual(["cop-med-1", "cop-med-2"]);
		r = setTierModels(r, "copilot", "heavy", []);
		expect(r.backends.copilot.tiers.heavy).toBeUndefined();
	});

	it("setFallbackChain replaces the chain", () => {
		const r = setFallbackChain(sample(), ["copilot", "openrouter"]);
		expect(r.fallbackChain).toEqual(["copilot", "openrouter"]);
	});

	it("tierModels normalizes string and list forms", () => {
		const b = sample().backends.openrouter;
		expect(tierModels(b, "heavy")).toEqual(["or-heavy-1", "or-heavy-2"]);
		expect(tierModels(b, "light")).toEqual(["or-light"]);
		expect(tierModels(b, "medium")).toEqual([]);
		expect(tierModels(undefined, "heavy")).toEqual([]);
	});

	it("cloneDraft produces an independent copy", () => {
		const a = sample();
		const b = cloneDraft(a);
		b.backends.openrouter.tiers.heavy = ["x"];
		expect(a.backends.openrouter.tiers.heavy).toEqual(["or-heavy-1", "or-heavy-2"]);
	});
});

describe("validateDraft", () => {
	it("accepts a valid draft", () => {
		expect(validateDraft(sample())).toEqual({ ok: true });
	});

	it("rejects a backend with no tiers with a specific message", () => {
		const r = validateDraft(addBackend(sample(), "empty"));
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/declares no tiers/);
	});

	it("rejects a chain referencing an unknown backend", () => {
		const bad = setFallbackChain(sample(), ["ghost"]);
		const r = validateDraft(bad);
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/unknown backend 'ghost'/);
	});
});

describe("writeAliasesConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gw-write-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a valid draft atomically and round-trips through the loader", () => {
		const p = join(dir, "aliases.json");
		const draft = setTierModels(sample(), "copilot", "light", ["cop-light"]);
		writeAliasesConfig(p, draft);
		const reloaded = loadAliasesConfigRaw(p);
		expect(reloaded).toEqual(draft);
		// pretty-printed with a trailing newline
		expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
	});

	it("refuses to write an invalid draft", () => {
		const p = join(dir, "aliases.json");
		expect(() => writeAliasesConfig(p, addBackend(sample(), "empty"))).toThrow(
			/refusing to write invalid aliases.json/,
		);
	});
});
