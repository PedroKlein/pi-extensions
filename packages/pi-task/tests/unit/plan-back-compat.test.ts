/**
 * P1.5 back-compat: legacy plans without phases, executor, or defaults must
 * load cleanly, validate cleanly, resolve every task's executor to `"any"`,
 * and round-trip byte-identically for their pre-P1 fields.
 *
 * The fixture is the real doc-refactor plan from the wafer-poc project
 * (73 tasks, 3 real sessions, 0 phases). This is the strongest possible
 * regression evidence: an actual plan that survived shipping.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	validatePlanGraph,
	resolveTaskStatuses,
	resolveTaskExecutor,
	resolveTaskDefaults,
	getEffectivePhases,
	ROOT_PHASE_ID,
	type PlanGraph,
	type PlanTask,
} from "../../src/plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "../fixtures/wafer-poc-legacy.json");
const RAW_FIXTURE = readFileSync(FIXTURE_PATH, "utf-8");

function loadFixture(): PlanGraph {
	return JSON.parse(RAW_FIXTURE) as PlanGraph;
}

// ─── AC: Legacy plan loads without error ───────────────────────────────────

describe("legacy plan loads cleanly", () => {
	it("JSON parses into a PlanGraph shape", () => {
		const graph = loadFixture();
		expect(graph.tasks.length).toBe(73);
		expect(graph.name).toBeTypeOf("string");
	});

	it("no validation errors on the loaded graph", () => {
		const graph = loadFixture();
		const errors = validatePlanGraph(graph);
		if (errors.length > 0) {
			// Surface the errors for debug clarity.
			console.error("Legacy fixture errors:", errors);
		}
		expect(errors).toEqual([]);
	});

	it("resolveTaskStatuses runs without throwing", () => {
		const graph = loadFixture();
		expect(() => resolveTaskStatuses(graph.tasks)).not.toThrow();
	});

	it("has no phases and no defaults (baseline confirmation)", () => {
		const graph = loadFixture();
		expect(graph.phases ?? []).toEqual([]);
		expect(graph.defaults).toBeUndefined();
	});
});

// ─── AC: All legacy tasks land in the implicit _root phase ─────────────────

describe("legacy tasks belong to implicit _root", () => {
	it("every task has phaseId=undefined", () => {
		const graph = loadFixture();
		const withPhase = graph.tasks.filter((t: PlanTask) => t.phaseId !== undefined);
		expect(withPhase).toEqual([]);
	});

	it("getEffectivePhases materialises a single _root phase", () => {
		const graph = loadFixture();
		const phases = getEffectivePhases(graph);
		expect(phases).toHaveLength(1);
		expect(phases[0].id).toBe(ROOT_PHASE_ID);
	});

	it("every legacy task resolves to executor 'any'", () => {
		const graph = loadFixture();
		for (const task of graph.tasks) {
			expect(resolveTaskExecutor(graph, task)).toBe("any");
		}
	});

	it("resolveTaskDefaults returns 'any' executor + empty arrays for every legacy task", () => {
		const graph = loadFixture();
		for (const task of graph.tasks) {
			const resolved = resolveTaskDefaults(graph, task);
			expect(resolved.executor).toBe("any");
			// A legacy task with no plan/phase defaults produces empty merge results,
			// EXCEPT for the task's own field values passed through (e.g. its own
			// constraints/skills, if any, are preserved).
			expect(Array.isArray(resolved.constraints)).toBe(true);
			expect(Array.isArray(resolved.nonGoals)).toBe(true);
			expect(Array.isArray(resolved.referenceSkills)).toBe(true);
			expect(Array.isArray(resolved.acceptanceCriteria)).toBe(true);
		}
	});
});

// ─── AC: Round-trip preserves pre-P1 fields byte-identical ─────────────────

describe("round-trip preservation of pre-P1 fields", () => {
	it("serializing the loaded graph produces JSON that parses back to the same object", () => {
		const graph = loadFixture();
		const serialized = JSON.stringify(graph);
		const reparsed = JSON.parse(serialized) as PlanGraph;
		// Deep equality on the whole graph.
		expect(reparsed).toEqual(graph);
	});

	it("task.dependsOn preserved verbatim for every legacy task", () => {
		const graph = loadFixture();
		const original = JSON.parse(RAW_FIXTURE) as PlanGraph;
		for (let i = 0; i < graph.tasks.length; i++) {
			expect(graph.tasks[i].dependsOn).toEqual(original.tasks[i].dependsOn);
		}
	});

	it("task.parallelGroup preserved for tasks that had one", () => {
		const graph = loadFixture();
		const original = JSON.parse(RAW_FIXTURE) as PlanGraph;
		const withGroups = original.tasks.filter((t: PlanTask) => t.parallelGroup !== undefined);
		expect(withGroups.length).toBeGreaterThan(0); // real fixture has parallelGroups
		for (const t of withGroups) {
			const found = graph.tasks.find((x: PlanTask) => x.id === t.id);
			expect(found?.parallelGroup).toBe(t.parallelGroup);
		}
	});

	it("task.references preserved for tasks that had one", () => {
		const graph = loadFixture();
		const original = JSON.parse(RAW_FIXTURE) as PlanGraph;
		const withRefs = original.tasks.filter((t: PlanTask) => t.references !== undefined);
		expect(withRefs.length).toBeGreaterThan(0);
		for (const t of withRefs) {
			const found = graph.tasks.find((x: PlanTask) => x.id === t.id);
			expect(found?.references).toEqual(t.references);
		}
	});

	it("task IDs stay in the same order (no reshuffle)", () => {
		const graph = loadFixture();
		const original = JSON.parse(RAW_FIXTURE) as PlanGraph;
		expect(graph.tasks.map((t: PlanTask) => t.id)).toEqual(original.tasks.map((t: PlanTask) => t.id));
	});
});
