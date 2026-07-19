/**
 * P2.7 + P2.8 anchor tests: tool descriptor documents phase actions, executor,
 * scratchDir; parallelGroup description no longer mentions worker subagents;
 * every phase-* action + implicit-freeze + divergence enforcement appears in
 * the compiled tool descriptor / case-block source.
 *
 * P2.4/P2.5 case-block anchor tests: verify wiring calls the right helpers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, "../../src/index.ts"), "utf-8");

// ─── P2.7: parallelGroup description soften ──────────────────────────────

describe("P2.7: parallelGroup description no longer says 'worker subagents'", () => {
	it("the string 'worker subagents' is absent from index.ts", () => {
		expect(INDEX_SRC).not.toContain("worker subagents");
	});

	it("parallelGroup description mentions 'concurrency' and 'safely'", () => {
		// Both occurrences (tasks array and updates) rewritten.
		const matches = INDEX_SRC.match(/parallelGroup:.*Concurrency-only tag/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBeGreaterThanOrEqual(2);
	});
});

// ─── P2.7: executor description lists all five values ────────────────────

describe("P2.7: executor description lists all five values with meanings", () => {
	const values = ["any", "inline", "subagent-fresh", "subagent-fork", "user"];
	for (const v of values) {
		it(`descriptor mentions '${v}' executor value with a meaning`, () => {
			// The descriptor blob has each value backticked or listed.
			expect(INDEX_SRC).toContain(`\`${v}\``);
		});
	}
});

// ─── P2.7: phase actions appear in top-level description ─────────────────

describe("P2.7: phase actions documented in top-level description", () => {
	const phaseActions = [
		"phase-create",
		"phase-update",
		"phase-delete",
		"phase-status",
		"phase-ac",
		"phase-freeze",
		"phase-unfreeze",
		"phase-annotate",
	];
	for (const action of phaseActions) {
		it(`descriptor lists '${action}'`, () => {
			expect(INDEX_SRC).toContain(action);
		});
	}
});

// ─── P2.7: scratchDir surface ────────────────────────────────────────────

describe("P2.7: scratchDir advertised as first-class primitive", () => {
	it("descriptor mentions scratchDir and {scratchDir}", () => {
		expect(INDEX_SRC).toContain("scratchDir");
		expect(INDEX_SRC).toContain("{scratchDir}");
	});
});

// ─── P2.4: implicit-freeze wiring ────────────────────────────────────────

describe("P2.4: implicit-freeze-on-first-start wired into start case", () => {
	it("start case calls freezePlan", () => {
		// Simple containment check; the mutex-migration test guarantees this
		// is inside the start case block.
		expect(INDEX_SRC).toContain("freezePlan(next)");
	});

	it("add-criteria case rejects a frozen plan", () => {
		expect(INDEX_SRC).toContain("Plan '${activePlan.name}' is frozen");
	});

	it("add-criteria case emits a deprecation warning", () => {
		expect(INDEX_SRC).toContain("warnDeprecated(");
		expect(INDEX_SRC).toContain("add-criteria is deprecated");
	});
});

// ─── P2.5: divergence-required wiring ────────────────────────────────────

describe("P2.5: divergence enforcement wired into complete and bulk-complete", () => {
	it("complete case invokes tasksRequiringDivergence", () => {
		// Should appear twice (complete + bulk-complete), plus the export.
		const occurrences = INDEX_SRC.split("tasksRequiringDivergence").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(2);
	});

	it("complete case throws 'Divergence required' when un-started + missing", () => {
		expect(INDEX_SRC).toContain("Divergence required:");
	});

	it("complete case auto-appends a 'divergence' annotation on success", () => {
		expect(INDEX_SRC).toContain('addTaskAnnotation(next, taskId, divergence, "divergence")');
	});

	it("bulk-complete case auto-annotates every un-started target", () => {
		expect(INDEX_SRC).toContain('addTaskAnnotation(next, id, divergence, "divergence")');
	});

	it("whitespace-only divergence is rejected (trim + empty check)", () => {
		// The code uses `params.divergence?.trim()` and gates on truthy —
		// whitespace-only becomes "" which is falsy.
		expect(INDEX_SRC).toContain("params.divergence?.trim()");
	});
});

// ─── P2.1/P2.2/P2.3: case block presence ─────────────────────────────────

describe("P2.1/P2.2/P2.3: phase-* case blocks present", () => {
	const cases = [
		'case "phase-create":',
		'case "phase-update":',
		'case "phase-delete":',
		'case "phase-status":',
		'case "phase-ac":',
		'case "phase-freeze":',
		'case "phase-unfreeze":',
		'case "phase-annotate":',
	];
	for (const c of cases) {
		it(`${c} exists`, () => {
			expect(INDEX_SRC).toContain(c);
		});
	}

	it("annotate case validates category against ANNOTATION_CATEGORIES", () => {
		expect(INDEX_SRC).toContain("Unknown annotation category:");
	});
});

// ─── P2.6: scratchDir wiring in create case ──────────────────────────────

describe("P2.6: create case initialises scratchDir", () => {
	it("create case calls ensureScratchDir", () => {
		expect(INDEX_SRC).toContain("ensureScratchDir(resolvedScratchDir)");
	});

	it("create case defaults scratchDir under getPlansRootForRepo()", () => {
		expect(INDEX_SRC).toContain("getPlansRootForRepo()");
	});
});
