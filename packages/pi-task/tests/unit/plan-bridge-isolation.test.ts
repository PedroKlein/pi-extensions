/**
 * P3.1 bridge tests: getSpawnBudget never throws, degrades to unknown, and
 * the module is isolated (only place pi-subagents is referenced).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getSpawnBudget,
	formatBudgetLine,
	scanTaggedArtifacts,
	_setBridgeMock,
	_setArtifactScanMock,
	_resetProbeLogGateForTests,
	type SpawnBudget,
} from "../../src/pi-subagents-bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "../../src");

beforeEach(() => {
	_setBridgeMock(null);
	_setArtifactScanMock(null);
	_resetProbeLogGateForTests();
});

describe("P3.1: bridge is the only pi-subagents reference point", () => {
	function listSrcFiles(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) listSrcFiles(p, out);
			else if (p.endsWith(".ts")) out.push(p);
		}
		return out;
	}

	it("no source file outside pi-subagents-bridge.ts imports 'pi-subagents' at compile time", () => {
		const files = listSrcFiles(SRC_DIR);
		const violators: string[] = [];
		for (const f of files) {
			if (f.endsWith("pi-subagents-bridge.ts")) continue;
			const src = readFileSync(f, "utf-8");
			// Look for real import / require statements, not prose references.
			const realImport =
				/(^|\n)\s*import\s[^;\n]*from\s+["']pi-subagents["']/.test(src) ||
				/(^|\n)\s*import\s*\(\s*["']pi-subagents["']\s*\)/.test(src) ||
				/require\s*\(\s*["']pi-subagents["']\s*\)/.test(src);
			if (realImport) {
				violators.push(f);
			}
		}
		expect(violators).toEqual([]);
	});

	it("bridge itself references pi-subagents only via dynamic import (specifier assembled at runtime)", () => {
		const src = readFileSync(join(SRC_DIR, "pi-subagents-bridge.ts"), "utf-8");
		// No `import ... from "pi-subagents"` statement at the top level.
		const staticImport = src.match(/^import\s[^;]*from\s+["']pi-subagents["']/m);
		expect(staticImport).toBeNull();
		// Dynamic import call exists (the specifier is assembled at runtime
		// so tsc doesn't try to resolve the module at build time).
		expect(src).toContain("await import(");
		expect(src).toContain('["pi", "subagents"].join("-")');
	});
});

describe("P3.1: getSpawnBudget happy path", () => {
	it("returns a fully-typed budget when probe succeeds", async () => {
		_setBridgeMock({
			getSpawnBudget: () => ({
				spawned: 12,
				cap: 40,
				remaining: 28,
				activeRuns: 3,
			}),
		});
		const b = await getSpawnBudget();
		expect(b).toEqual({ spawned: 12, cap: 40, remaining: 28, activeRuns: 3 });
	});

	it("derives `remaining` from cap/spawned when probe returns partial numbers", async () => {
		_setBridgeMock({
			getSpawnBudget: () => ({
				spawned: 30,
				cap: 40,
				// Deliberately omit remaining to test normaliser.
				remaining: NaN as unknown as number,
				activeRuns: 2,
			}),
		});
		const b = await getSpawnBudget();
		expect(b.remaining).toBe(10);
	});

	it("supports legacy `getBudget` shape and derives remaining", async () => {
		_setBridgeMock({
			getBudget: () => ({ spawned: 5, cap: 10, activeRuns: 1 }),
		});
		const b = await getSpawnBudget();
		expect(b.spawned).toBe(5);
		expect(b.cap).toBe(10);
		expect(b.remaining).toBe(5);
	});
});

describe("P3.1: getSpawnBudget degradation paths", () => {
	it("returns unknown when the mock is disabled", async () => {
		_setBridgeMock("disabled");
		const b = await getSpawnBudget();
		expect(b.remaining).toBe("unknown");
		expect(b.spawned).toBe("unknown");
		expect(b.reason).toBe("mock-disabled");
	});

	it("returns unknown when neither probe export is present", async () => {
		_setBridgeMock({}); // empty object, no probes
		const b = await getSpawnBudget();
		expect(b.remaining).toBe("unknown");
		expect(b.reason).toBe("no-probe-export");
	});

	it("returns unknown when probe throws", async () => {
		_setBridgeMock({
			getSpawnBudget: () => {
				throw new Error("boom");
			},
		});
		const b = await getSpawnBudget();
		expect(b.remaining).toBe("unknown");
		expect(b.reason).toBe("boom");
	});

	it("returns unknown when probe returns malformed data", async () => {
		_setBridgeMock({
			getSpawnBudget: () => ({
				spawned: "twelve" as unknown as number,
				cap: 40,
				remaining: 28,
				activeRuns: 3,
			}),
		});
		const b = await getSpawnBudget();
		expect(b.remaining).toBe("unknown");
		expect(b.reason).toBe("malformed-probe-response");
	});

	it("never throws — every degradation path resolves cleanly", async () => {
		const paths: Array<{ probe: unknown; label: string }> = [
			{ probe: "disabled", label: "disabled" },
			{ probe: {}, label: "empty" },
			{ probe: { getSpawnBudget: () => { throw new Error("x"); } }, label: "throws" },
			{ probe: null, label: "null-fallback" },
		];
		for (const p of paths) {
			_setBridgeMock(p.probe as any);
			await expect(getSpawnBudget()).resolves.toBeTruthy();
		}
	});

	it("only logs probe failure once per session (rate-limited)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setBridgeMock("disabled");
		await getSpawnBudget();
		await getSpawnBudget();
		await getSpawnBudget();
		expect(warnSpy.mock.calls.length).toBe(1);
		warnSpy.mockRestore();
	});
});

describe("P3.1: formatBudgetLine", () => {
	it("formats numeric budget as 'spawns: N/M remaining · K active runs'", () => {
		const b: SpawnBudget = { spawned: 12, cap: 40, remaining: 28, activeRuns: 3 };
		expect(formatBudgetLine(b)).toBe("spawns: 12/40 remaining · 3 active runs");
	});

	it("collapses to 'spawns: probe-unavailable' when any field is unknown", () => {
		const b: SpawnBudget = { spawned: "unknown", cap: "unknown", remaining: "unknown", activeRuns: "unknown" };
		expect(formatBudgetLine(b)).toBe("spawns: probe-unavailable");
	});

	it("does not invent numbers from partial data", () => {
		const b: SpawnBudget = { spawned: 12, cap: "unknown", remaining: "unknown", activeRuns: 3 };
		expect(formatBudgetLine(b)).toBe("spawns: probe-unavailable");
	});
});

describe("P3.1: scanTaggedArtifacts", () => {
	it("returns [] when scanner mock is absent", async () => {
		const arts = await scanTaggedArtifacts();
		expect(arts).toEqual([]);
	});

	it("returns injected results from mock", async () => {
		_setArtifactScanMock(async () => [{ taskId: "P3.5", artifactPath: "/tmp/artifact.json" }]);
		const arts = await scanTaggedArtifacts();
		expect(arts).toHaveLength(1);
		expect(arts[0].taskId).toBe("P3.5");
	});

	it("returns [] and does not throw when mock throws", async () => {
		_setArtifactScanMock(async () => { throw new Error("scan-failed"); });
		const arts = await scanTaggedArtifacts();
		expect(arts).toEqual([]);
	});
});

describe("P3.1: design doc coverage", () => {
	it("design doc mentions 'compatibility' and the api surface", () => {
		const doc = readFileSync(
			join(HERE, "../../docs/design/pi-subagents-coupling.md"),
			"utf-8",
		);
		expect(doc.toLowerCase()).toContain("compatibility");
		expect(doc).toContain("getSpawnBudget");
		expect(doc).toContain("SpawnBudget");
	});

	it("design doc documents failure modes", () => {
		const doc = readFileSync(
			join(HERE, "../../docs/design/pi-subagents-coupling.md"),
			"utf-8",
		);
		expect(doc.toLowerCase()).toContain("failure mode");
	});

	it("design doc contains the P3.4 artifact metadata schema", () => {
		const doc = readFileSync(
			join(HERE, "../../docs/design/pi-subagents-coupling.md"),
			"utf-8",
		);
		expect(doc).toContain("taskId");
		expect(doc).toContain("planName");
		expect(doc).toContain("metadata.json");
	});
});
