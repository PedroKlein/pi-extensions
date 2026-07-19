/**
 * P6.1: plan-widget rendering tests. Verifies:
 *   - Legacy plans (no phases) render exactly as before.
 *   - Phased plans render with phase headers and per-phase counts.
 *   - Executor badges appear on non-any-executor tasks.
 *   - Divergence badge appears on tasks with a divergence-category annotation.
 *   - Blocker badge appears on tasks with a blocker-category annotation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	addPhase,
	freezePhase,
	addTaskAnnotation,
	setTaskStatus,
	formatPlanGraphText,
	type PlanGraph,
	type PlanTask,
} from "../../src/plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_FIXTURE = join(HERE, "../fixtures/wafer-poc-legacy.json");

function graphOf(...tasks: PlanTask[]): PlanGraph {
	return createPlanGraph({ name: "test-plan", tasks: resolveTaskStatuses(tasks) });
}

// ─── AC: legacy plans (no phases) render as before ──────────────────────

describe("legacy rendering unchanged", () => {
	it("legacy fixture renders without phase headers", () => {
		const graph = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf-8")) as PlanGraph;
		const text = formatPlanGraphText(graph);
		expect(text).not.toContain("▸ Phase");
		// Should still start with "# Plan:" header.
		expect(text.startsWith("# Plan:")).toBe(true);
	});

	it("legacy fixture renders every task in flat order", () => {
		const graph = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf-8")) as PlanGraph;
		const text = formatPlanGraphText(graph);
		for (const t of graph.tasks) {
			// Each task ID must appear in the rendering.
			expect(text).toContain(t.id + ":");
		}
	});
});

// ─── AC: phased plans render with phase headers + counts ────────────────

describe("phased rendering", () => {
	it("phase header shows title, done/total, executor, frozen state", () => {
		const t1 = createPlanTask({ id: "T1", title: "one", description: "", order: 1 });
		const t2 = createPlanTask({ id: "T2", title: "two", description: "", order: 2 });
		let g: PlanGraph = { ...graphOf({ ...t1, phaseId: "PA" }, { ...t2, phaseId: "PA" }) };
		g = addPhase(g, {
			id: "PA",
			title: "Phase A",
			executor: "subagent-fresh",
			acceptanceCriteria: ["AC: PA one thing done"],
		});
		g = freezePhase(g, "PA");
		g = setTaskStatus(g, "T1", "done");
		const text = formatPlanGraphText(g);
		expect(text).toContain("▸ Phase PA: Phase A — 1/2 done 🧊 [executor: subagent-fresh]");
		expect(text).toContain("Phase AC (frozen):");
		expect(text).toContain("• AC: PA one thing done");
	});

	it("tasks group under their phase header", () => {
		const t1 = createPlanTask({ id: "T1", title: "one", description: "", order: 1 });
		const t2 = createPlanTask({ id: "T2", title: "two", description: "", order: 2 });
		let g: PlanGraph = { ...graphOf({ ...t1, phaseId: "PA" }, { ...t2, phaseId: "PB" }) };
		g = addPhase(g, { id: "PA", title: "A" });
		g = addPhase(g, { id: "PB", title: "B", order: 2 });
		const text = formatPlanGraphText(g);
		const paIdx = text.indexOf("▸ Phase PA:");
		const pbIdx = text.indexOf("▸ Phase PB:");
		const t1Idx = text.indexOf("T1:");
		const t2Idx = text.indexOf("T2:");
		expect(paIdx).toBeLessThan(t1Idx);
		expect(t1Idx).toBeLessThan(pbIdx);
		expect(pbIdx).toBeLessThan(t2Idx);
	});

	it("phase-less tasks in a phased plan land under implicit _root header", () => {
		const t1 = createPlanTask({ id: "T1", title: "one", description: "", order: 1 });
		const t2 = createPlanTask({ id: "T2", title: "two", description: "", order: 2 });
		let g: PlanGraph = { ...graphOf({ ...t1, phaseId: "PA" }, t2) };
		g = addPhase(g, { id: "PA", title: "A" });
		const text = formatPlanGraphText(g);
		expect(text).toContain("▸ Phase _root (implicit)");
	});
});

// ─── AC: executor badge on non-any tasks ─────────────────────────────────

describe("executor badges", () => {
	it("renders [executor: subagent-fresh] on task with that executor", () => {
		const t: PlanTask = {
			...createPlanTask({ id: "T1", title: "audit", description: "", order: 1 }),
			executor: "subagent-fresh",
		};
		const text = formatPlanGraphText(graphOf(t));
		expect(text).toContain("[executor: subagent-fresh]");
	});

	it("omits executor badge on 'any' or absent", () => {
		const t = createPlanTask({ id: "T1", title: "plain", description: "", order: 1 });
		const text = formatPlanGraphText(graphOf(t));
		expect(text).not.toContain("[executor:");
	});

	it("renders [executor: user] badge", () => {
		const t: PlanTask = {
			...createPlanTask({ id: "T1", title: "commit", description: "", order: 1 }),
			executor: "user",
		};
		const text = formatPlanGraphText(graphOf(t));
		expect(text).toContain("[executor: user]");
	});
});

// ─── AC: divergence & blocker badges ─────────────────────────────────────

describe("annotation-driven badges", () => {
	it("⚠️ divergence badge on tasks with divergence annotation", () => {
		const t = createPlanTask({ id: "T1", title: "t", description: "", order: 1 });
		let g = graphOf(t);
		g = addTaskAnnotation(g, "T1", "note", "divergence");
		expect(formatPlanGraphText(g)).toContain("⚠️ divergence");
	});

	it("🛑 blocker badge on tasks with blocker annotation", () => {
		const t = createPlanTask({ id: "T1", title: "t", description: "", order: 1 });
		let g = graphOf(t);
		g = addTaskAnnotation(g, "T1", "stuck", "blocker");
		expect(formatPlanGraphText(g)).toContain("🛑 blocker");
	});

	it("no badge when annotation category is note", () => {
		const t = createPlanTask({ id: "T1", title: "t", description: "", order: 1 });
		let g = graphOf(t);
		g = addTaskAnnotation(g, "T1", "informational", "note");
		expect(formatPlanGraphText(g)).not.toContain("⚠️ divergence");
		expect(formatPlanGraphText(g)).not.toContain("🛑 blocker");
	});
});

// ─── Plan-level markers ─────────────────────────────────────────────────

describe("plan-level markers", () => {
	it("shows 🧊 frozen when plan.frozen", () => {
		const g: PlanGraph = { ...graphOf(createPlanTask({ id: "T1", title: "t", description: "", order: 1 })), frozen: true };
		expect(formatPlanGraphText(g)).toContain("Plan: 🧊 frozen");
	});

	it("shows scratchDir path when set", () => {
		const g: PlanGraph = { ...graphOf(createPlanTask({ id: "T1", title: "t", description: "", order: 1 })), scratchDir: "/tmp/x" };
		expect(formatPlanGraphText(g)).toContain("scratchDir: /tmp/x");
	});
});
