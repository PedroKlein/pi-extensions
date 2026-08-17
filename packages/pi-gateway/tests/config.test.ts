import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AliasesConfigError,
	DEFAULT_CAP_STATUS_CODES,
	loadAliasesConfig,
	parseAliasesConfig,
} from "../src/config.js";

const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"aliases-full.json",
);

describe("aliases.json loader — valid inputs", () => {
	it("parses the full sample fixture from tests/fixtures", () => {
		const cfg = parseAliasesConfig(readFileSync(FIXTURE, "utf8"), FIXTURE);
		expect(cfg.fallbackChain).toEqual(["hai-proxy", "github-copilot"]);
		// Single-string tiers normalize to 1-element arrays.
		expect(cfg.backends["hai-proxy"].tiers.heavy).toEqual(["anthropic--claude-sonnet-4-5"]);
		expect(cfg.backends["hai-proxy"].capStatusCodes).toEqual([402, 429]);
	});

	it("accepts a minimal single-backend config with only tiers", () => {
		const src = JSON.stringify({
			fallbackChain: ["hai-proxy"],
			backends: { "hai-proxy": { tiers: { heavy: "some/model" } } },
		});
		const cfg = parseAliasesConfig(src);
		expect(cfg.fallbackChain).toEqual(["hai-proxy"]);
		// Single string is normalized to a 1-element array.
		expect(cfg.backends["hai-proxy"].tiers).toEqual({ heavy: ["some/model"] });
		// Defaults applied
		expect(cfg.backends["hai-proxy"].capStatusCodes).toEqual(DEFAULT_CAP_STATUS_CODES);
		expect(cfg.backends["hai-proxy"].resetSchedule).toBeUndefined();
		expect(cfg.backends["hai-proxy"].quotaHint).toBeUndefined();
	});

	it("accepts an ordered list of models per tier (indexed diversity)", () => {
		const src = JSON.stringify({
			fallbackChain: ["hai-proxy"],
			backends: {
				"hai-proxy": {
					tiers: {
						heavy: ["anthropic--claude-4.8-opus", "gpt-5.5"],
						light: ["anthropic--claude-4.5-haiku", "gpt-5-mini"],
					},
				},
			},
		});
		const cfg = parseAliasesConfig(src);
		expect(cfg.backends["hai-proxy"].tiers.heavy).toEqual([
			"anthropic--claude-4.8-opus",
			"gpt-5.5",
		]);
		expect(cfg.backends["hai-proxy"].tiers.light).toEqual([
			"anthropic--claude-4.5-haiku",
			"gpt-5-mini",
		]);
	});

	it("rejects an empty tier list with cause=semantic", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: { heavy: [] } } },
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "semantic" }),
		);
	});

	it("normalizes optional fields to defaults so downstream sees a stable shape", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: { light: "m1" } } },
		});
		const cfg = parseAliasesConfig(src);
		expect(cfg.backends.a.capStatusCodes).toEqual([402, 429]);
	});
});

describe("aliases.json loader — invalid inputs", () => {
	it("rejects missing file with cause=missing", () => {
		expect(() => loadAliasesConfig("/nonexistent/does-not-exist.json")).toThrowError(
			expect.objectContaining({ name: "AliasesConfigError", cause: "missing" }),
		);
	});

	it("rejects invalid JSON with cause=parse", () => {
		expect(() => parseAliasesConfig("{ this is not json")).toThrowError(
			expect.objectContaining({ cause: "parse" }),
		);
	});

	it("rejects missing required field with cause=schema", () => {
		const src = JSON.stringify({ backends: { a: { tiers: { light: "m" } } } });
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "schema" }),
		);
	});

	it("rejects wrong type in tiers", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: { heavy: 123 } } },
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "schema" }),
		);
	});

	it("rejects unknown top-level key", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: { light: "m" } } },
			bogus: true,
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "schema" }),
		);
	});

	it("rejects unknown tier slot name", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: { megaHeavy: "m" } } },
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "schema" }),
		);
	});

	it("rejects fallbackChain referencing an undeclared backend", () => {
		const src = JSON.stringify({
			fallbackChain: ["a", "does-not-exist"],
			backends: { a: { tiers: { light: "m" } } },
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({
				cause: "semantic",
				message: expect.stringContaining("does-not-exist"),
			}),
		);
	});

	it("rejects backend with empty tiers", () => {
		const src = JSON.stringify({
			fallbackChain: ["a"],
			backends: { a: { tiers: {} } },
		});
		expect(() => parseAliasesConfig(src)).toThrowError(
			expect.objectContaining({ cause: "semantic" }),
		);
	});
});

describe("aliases.json loader — filesystem round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-gateway-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads a real file on disk", () => {
		const path = join(dir, "aliases.json");
		writeFileSync(
			path,
			JSON.stringify({
				fallbackChain: ["a"],
				backends: { a: { tiers: { light: "m" } } },
			}),
		);
		const cfg = loadAliasesConfig(path);
		expect(cfg.backends.a.tiers.light).toEqual(["m"]);
	});
});
