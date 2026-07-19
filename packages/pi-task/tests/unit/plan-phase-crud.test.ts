/**
 * Phase 2 tests: phase CRUD, phase gates, annotation categories,
 * implicit-freeze-on-start, divergence enforcement, scratchDir primitive.
 * Covers P2.1–P2.6 at the plan.ts primitive layer.
 */

import { describe, it, expect } from "vitest";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	addPhase,
	updatePhase,
	deletePhase,
	getPhaseStatus,
	addPhaseAcceptanceCriteria,
	freezePhase,
	unfreezePhase,
	addPhaseAnnotation,
	freezePlan,
	addTaskAnnotation,
	tasksRequiringDivergence,
	defaultScratchDir,
	expandScratchDirTemplate,
	expandScratchDirInResolved,
	resolveTaskDefaults,
	setTaskStatus,
	ROOT_PHASE_ID,
	ANNOTATION_CATEGORIES,
	type PlanGraph,
	type PlanTask,
} from "../../src/plan.js";

function baseGraph(tasks: PlanTask[] = []): PlanGraph {
	return createPlanGraph({ name: "p2", tasks: resolveTaskStatuses(tasks) });
}

// ─── P2.1: phase CRUD ─────────────────────────────────────────────────────

describe("P2.1: phase CRUD", () => {
	it("addPhase creates a phase and refuses reserved _root id", () => {
		const g = addPhase(baseGraph(), { id: "PA", title: "Phase A" });
		expect(g.phases).toHaveLength(1);
		expect(g.phases![0].id).toBe("PA");
		expect(() => addPhase(g, { id: ROOT_PHASE_ID, title: "root" })).toThrow(/reserved/);
	});

	it("addPhase rejects duplicate ID", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "Phase A" });
		expect(() => addPhase(g, { id: "PA", title: "dup" })).toThrow(/already exists/);
	});

	it("updatePhase changes supplied fields only", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A", description: "orig" });
		g = updatePhase(g, "PA", { title: "renamed" });
		expect(g.phases![0].title).toBe("renamed");
		expect(g.phases![0].description).toBe("orig"); // untouched
	});

	it("deletePhase refuses when tasks reference the phase; error names them", () => {
		const t1 = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		const t2 = createPlanTask({ id: "T2", title: "t2", description: "", order: 2 });
		let g: PlanGraph = { ...baseGraph([{ ...t1, phaseId: "PA" }, { ...t2, phaseId: "PA" }]) };
		g = addPhase(g, { id: "PA", title: "A" });
		expect(() => deletePhase(g, "PA")).toThrow(/T1.*T2|T2.*T1/);
	});

	it("deletePhase refuses when another phase depends on it", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = addPhase(g, { id: "PB", title: "B", dependsOn: ["PA"] });
		expect(() => deletePhase(g, "PA")).toThrow(/PB/);
	});

	it("deletePhase succeeds when no tasks/phases reference it", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = deletePhase(g, "PA");
		expect(g.phases).toEqual([]);
	});

	it("deletePhase refuses _root", () => {
		expect(() => deletePhase(baseGraph(), ROOT_PHASE_ID)).toThrow(/implicit/);
	});

	it("getPhaseStatus reports counts, resolved executor, frozen, acceptanceCriteria", () => {
		const t1: PlanTask = {
			...createPlanTask({ id: "T1", title: "t1", description: "", order: 1 }),
			phaseId: "PA",
			status: "done",
		};
		const t2: PlanTask = {
			...createPlanTask({ id: "T2", title: "t2", description: "", order: 2 }),
			phaseId: "PA",
			status: "in-progress",
		};
		let g: PlanGraph = { ...baseGraph([t1, t2]), defaults: { executor: "any" } };
		g = addPhase(g, {
			id: "PA",
			title: "A",
			acceptanceCriteria: ["AC: PA done"],
			executor: "subagent-fresh",
		});
		g = freezePhase(g, "PA");

		const report = getPhaseStatus(g, "PA");
		expect(report.id).toBe("PA");
		expect(report.frozen).toBe(true);
		expect(report.executor).toBe("subagent-fresh");
		expect(report.resolvedExecutor).toBe("subagent-fresh");
		expect(report.acceptanceCriteria).toEqual(["AC: PA done"]);
		expect(report.totalTasks).toBe(2);
		expect(report.taskCounts.done).toBe(1);
		expect(report.taskCounts["in-progress"]).toBe(1);
	});

	it("getPhaseStatus on _root reports all phase-less tasks", () => {
		const t1 = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		const g = baseGraph([t1]);
		const report = getPhaseStatus(g, ROOT_PHASE_ID);
		expect(report.totalTasks).toBe(1);
	});
});

// ─── P2.2: phase gates (ac, freeze, annotate) ────────────────────────────

describe("P2.2: phase gates", () => {
	it("phase-ac appends and rejects when frozen", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = addPhaseAcceptanceCriteria(g, "PA", ["AC: one"]);
		expect(g.phases![0].acceptanceCriteria).toEqual(["AC: one"]);
		g = freezePhase(g, "PA");
		expect(() => addPhaseAcceptanceCriteria(g, "PA", ["AC: two"])).toThrow(/frozen/);
	});

	it("phase-freeze sets frozen:true", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = freezePhase(g, "PA");
		expect(g.phases![0].frozen).toBe(true);
	});

	it("phase-annotate appends with category and rejects unknown categories", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = addPhaseAnnotation(g, "PA", "diverged from spec", "divergence");
		expect(g.phases![0].annotations).toHaveLength(1);
		expect(g.phases![0].annotations[0].category).toBe("divergence");
		// @ts-expect-error — intentional invalid category
		expect(() => addPhaseAnnotation(g, "PA", "x", "invalid")).toThrow(/Unknown/);
	});

	it("phase-freeze/unfreeze round-trips", () => {
		let g = addPhase(baseGraph(), { id: "PA", title: "A" });
		g = freezePhase(g, "PA");
		expect(g.phases![0].frozen).toBe(true);
		g = unfreezePhase(g, "PA");
		expect(g.phases![0].frozen).toBe(false);
	});
});

// ─── P2.3: annotation categories ─────────────────────────────────────────

describe("P2.3: annotation categories on tasks", () => {
	it("addTaskAnnotation accepts and stores category", () => {
		const t = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		let g = baseGraph([t]);
		g = addTaskAnnotation(g, "T1", "diverged from acceptance criteria", "divergence");
		expect(g.tasks[0].annotations[0].category).toBe("divergence");
	});

	it("ANNOTATION_CATEGORIES exposes the four canonical values", () => {
		expect(ANNOTATION_CATEGORIES).toEqual(["note", "divergence", "blocker", "decision"]);
	});

	it("empty category omits the field (round-trip clean)", () => {
		const t = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		let g = baseGraph([t]);
		g = addTaskAnnotation(g, "T1", "plain note");
		expect("category" in g.tasks[0].annotations[0]).toBe(false);
	});
});

// ─── P2.4: plan-level implicit freeze ────────────────────────────────────

describe("P2.4: plan.frozen implicit-on-first-start", () => {
	it("freezePlan sets plan.frozen and is idempotent", () => {
		let g = baseGraph();
		expect(g.frozen).toBeUndefined();
		g = freezePlan(g);
		expect(g.frozen).toBe(true);
		const before = g;
		g = freezePlan(g);
		expect(g).toBe(before); // no-op returns same reference
	});
});

// ─── P2.5: divergence enforcement helper ─────────────────────────────────

describe("P2.5: tasksRequiringDivergence", () => {
	it("returns IDs of tasks not in 'in-progress'", () => {
		const t1 = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		const t2 = createPlanTask({ id: "T2", title: "t2", description: "", order: 2 });
		let g = baseGraph([t1, t2]);
		g = setTaskStatus(g, "T1", "in-progress");
		// T2 is still ready (never started).
		expect(tasksRequiringDivergence(g, ["T1", "T2"])).toEqual(["T2"]);
	});

	it("returns empty when every target is in-progress", () => {
		const t1 = createPlanTask({ id: "T1", title: "t1", description: "", order: 1 });
		let g = baseGraph([t1]);
		g = setTaskStatus(g, "T1", "in-progress");
		expect(tasksRequiringDivergence(g, ["T1"])).toEqual([]);
	});
});

// ─── P2.6: scratchDir primitives ─────────────────────────────────────────

describe("P2.6: scratchDir primitives", () => {
	it("defaultScratchDir joins plansRoot + planName + scratch", () => {
		expect(defaultScratchDir("my-plan", "/tmp/plans")).toBe("/tmp/plans/my-plan/scratch");
		expect(defaultScratchDir("x", "/tmp/plans/")).toBe("/tmp/plans/x/scratch");
	});

	it("expandScratchDirTemplate replaces {scratchDir} with absolute path", () => {
		expect(expandScratchDirTemplate("{scratchDir}/notes.md", "/abs/path")).toBe("/abs/path/notes.md");
	});

	it("expandScratchDirTemplate leaves unresolved template intact when scratchDir undefined", () => {
		expect(expandScratchDirTemplate("{scratchDir}/notes.md", undefined)).toBe("{scratchDir}/notes.md");
	});

	it("expandScratchDirInResolved maps every string array field", () => {
		const t = createPlanTask({
			id: "T1", title: "t", description: "", order: 1,
			constraints: ["cannot touch {scratchDir}/lock"],
			references: { files: ["{scratchDir}/spec.md"] },
		});
		const g = baseGraph([t]);
		const resolved = resolveTaskDefaults(g, g.tasks[0]);
		const expanded = expandScratchDirInResolved(resolved, "/abs");
		expect(expanded.constraints).toEqual(["cannot touch /abs/lock"]);
		expect(expanded.referenceFiles).toEqual(["/abs/spec.md"]);
	});
});
