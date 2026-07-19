/**
 * P1.1 tracer-bullet tests: Phase entity in the data model.
 *
 * Covers:
 *  - Phase interface exists and PlanTask.phaseId is optional (compile-time).
 *  - Implicit `_root` phase for plans without any phases.
 *  - Phase-DAG cycle detection is independent of task-DAG cycle detection.
 *  - Referential integrity: task.phaseId must target an existing phase.
 *  - Reserved `_root` ID.
 *  - Executor cascade (plan → phase.defaults → phase → task).
 */

import { describe, it, expect } from "vitest";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	validatePlanGraph,
	getEffectivePhases,
	resolveTaskExecutor,
	ROOT_PHASE_ID,
	type Phase,
	type PlanGraph,
	type PlanTask,
} from "../../src/plan.js";

function makeTask(id: string, order: number, dependsOn: string[] = [], phaseId?: string): PlanTask {
	return {
		...createPlanTask({ id, title: `T ${id}`, description: `D ${id}`, order, dependsOn }),
		phaseId,
	};
}

function makePhase(id: string, order: number, dependsOn: string[] = []): Phase {
	return {
		id,
		title: `Phase ${id}`,
		description: `Desc ${id}`,
		order,
		dependsOn,
		annotations: [],
	};
}

function makeGraph(tasks: PlanTask[], phases?: Phase[]): PlanGraph {
	const g = createPlanGraph({ name: "phase-test", tasks: resolveTaskStatuses(tasks) });
	return phases ? { ...g, phases } : g;
}

// ─── Implicit _root phase ──────────────────────────────────────────────────

describe("getEffectivePhases", () => {
	it("returns a single _root phase when graph.phases is missing", () => {
		const g = makeGraph([makeTask("t1", 1)]);
		const phases = getEffectivePhases(g);
		expect(phases).toHaveLength(1);
		expect(phases[0].id).toBe(ROOT_PHASE_ID);
		expect(phases[0].dependsOn).toEqual([]);
	});

	it("returns a single _root phase when graph.phases is empty", () => {
		const g = makeGraph([makeTask("t1", 1)], []);
		const phases = getEffectivePhases(g);
		expect(phases).toHaveLength(1);
		expect(phases[0].id).toBe(ROOT_PHASE_ID);
	});

	it("returns user phases when declared and does not inject _root", () => {
		const g = makeGraph([makeTask("t1", 1, [], "P1")], [makePhase("P1", 1)]);
		const phases = getEffectivePhases(g);
		expect(phases).toHaveLength(1);
		expect(phases[0].id).toBe("P1");
	});

	it("does not mutate the input graph", () => {
		const g = makeGraph([makeTask("t1", 1)]);
		const before = JSON.stringify(g);
		getEffectivePhases(g);
		expect(JSON.stringify(g)).toBe(before);
	});
});

// ─── Back-compat: phase-less plans stay valid ──────────────────────────────

describe("PlanTask.phaseId (back-compat)", () => {
	it("plan without phases and tasks without phaseId is valid (no errors)", () => {
		const g = makeGraph([makeTask("t1", 1), makeTask("t2", 2, ["t1"])]);
		const errors = validatePlanGraph(g);
		expect(errors).toHaveLength(0);
	});

	it("task with phaseId=undefined belongs to the implicit _root phase", () => {
		const t = makeTask("t1", 1);
		expect(t.phaseId).toBeUndefined();
	});
});

// ─── Phase-DAG cycle detection (tracer bullet) ─────────────────────────────

describe("phase-DAG cycle detection", () => {
	it("accepts a linear phase DAG", () => {
		const g = makeGraph(
			[makeTask("t1", 1, [], "P1"), makeTask("t2", 2, [], "P2")],
			[makePhase("P1", 1), makePhase("P2", 2, ["P1"])],
		);
		const errors = validatePlanGraph(g);
		expect(errors.filter((e) => e.message.includes("Phase"))).toHaveLength(0);
	});

	it("rejects a direct phase cycle (P1 ↔ P2)", () => {
		const g = makeGraph(
			[makeTask("t1", 1, [], "P1"), makeTask("t2", 2, [], "P2")],
			[makePhase("P1", 1, ["P2"]), makePhase("P2", 2, ["P1"])],
		);
		const errors = validatePlanGraph(g);
		const cycleErrors = errors.filter((e) => e.message.includes("Phase dependency cycle"));
		expect(cycleErrors.length).toBeGreaterThan(0);
	});

	it("rejects a 3-node phase cycle (P1 → P2 → P3 → P1)", () => {
		const g = makeGraph(
			[makeTask("t1", 1, [], "P1")],
			[
				makePhase("P1", 1, ["P3"]),
				makePhase("P2", 2, ["P1"]),
				makePhase("P3", 3, ["P2"]),
			],
		);
		const errors = validatePlanGraph(g);
		const cycleErrors = errors.filter((e) => e.message.includes("Phase dependency cycle"));
		expect(cycleErrors.length).toBeGreaterThan(0);
	});

	it("phase cycle is detected independently of task cycles", () => {
		// Tasks form a valid DAG; phases form a cycle. Should still error on the phase cycle.
		const g = makeGraph(
			[makeTask("t1", 1, [], "P1"), makeTask("t2", 2, ["t1"], "P2")],
			[makePhase("P1", 1, ["P2"]), makePhase("P2", 2, ["P1"])],
		);
		const errors = validatePlanGraph(g);
		const taskCycles = errors.filter((e) => e.message.includes("Dependency cycle"));
		const phaseCycles = errors.filter((e) => e.message.includes("Phase dependency cycle"));
		expect(taskCycles).toHaveLength(0);
		expect(phaseCycles.length).toBeGreaterThan(0);
	});
});

// ─── Referential integrity ────────────────────────────────────────────────

describe("phase referential integrity", () => {
	it("rejects a task pointing at an unknown phase", () => {
		const g = makeGraph([makeTask("t1", 1, [], "P99")], [makePhase("P1", 1)]);
		const errors = validatePlanGraph(g);
		const fkErrors = errors.filter((e) =>
			e.taskId === "t1" && e.message.includes("unknown phase"),
		);
		expect(fkErrors).toHaveLength(1);
	});

	it("accepts task.phaseId === _root even when no user phases declared", () => {
		const g = makeGraph([makeTask("t1", 1, [], ROOT_PHASE_ID)]);
		const errors = validatePlanGraph(g);
		expect(errors).toHaveLength(0);
	});

	it("rejects a user-defined phase using the reserved _root ID", () => {
		const g = makeGraph([makeTask("t1", 1)], [makePhase(ROOT_PHASE_ID, 1)]);
		const errors = validatePlanGraph(g);
		const reservedErrors = errors.filter((e) => e.message.includes("reserved"));
		expect(reservedErrors.length).toBeGreaterThan(0);
	});

	it("rejects duplicate phase IDs", () => {
		const g = makeGraph(
			[makeTask("t1", 1, [], "P1")],
			[makePhase("P1", 1), makePhase("P1", 2)],
		);
		const errors = validatePlanGraph(g);
		const dupErrors = errors.filter((e) => e.message.includes("Duplicate phase ID"));
		expect(dupErrors.length).toBeGreaterThan(0);
	});

	it("rejects a phase depending on an unknown phase", () => {
		const g = makeGraph([makeTask("t1", 1, [], "P1")], [makePhase("P1", 1, ["P99"])]);
		const errors = validatePlanGraph(g);
		const unknownDepErrors = errors.filter((e) => e.message.includes("unknown phase: P99"));
		expect(unknownDepErrors).toHaveLength(1);
	});
});

// ─── Executor cascade ─────────────────────────────────────────────────────

describe("resolveTaskExecutor", () => {
	it("falls back to 'any' when nothing is set", () => {
		const g = makeGraph([makeTask("t1", 1)]);
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("any");
	});

	it("plan.defaults.executor is used when nothing else is set", () => {
		const g: PlanGraph = {
			...makeGraph([makeTask("t1", 1)]),
			defaults: { executor: "subagent-fresh" },
		};
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("subagent-fresh");
	});

	it("phase.defaults.executor overrides plan.defaults.executor", () => {
		const g: PlanGraph = {
			...makeGraph(
				[makeTask("t1", 1, [], "P1")],
				[{ ...makePhase("P1", 1), defaults: { executor: "inline" } }],
			),
			defaults: { executor: "subagent-fresh" },
		};
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("inline");
	});

	it("phase.executor overrides phase.defaults.executor", () => {
		const g: PlanGraph = {
			...makeGraph(
				[makeTask("t1", 1, [], "P1")],
				[{ ...makePhase("P1", 1), executor: "subagent-fork", defaults: { executor: "inline" } }],
			),
		};
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("subagent-fork");
	});

	it("task.executor is highest priority", () => {
		const g: PlanGraph = {
			...makeGraph(
				[{ ...makeTask("t1", 1, [], "P1"), executor: "user" }],
				[{ ...makePhase("P1", 1), executor: "subagent-fork" }],
			),
			defaults: { executor: "subagent-fresh" },
		};
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("user");
	});

	it("phase-less task consults plan.defaults directly", () => {
		const g: PlanGraph = {
			...makeGraph([makeTask("t1", 1)]),
			defaults: { executor: "subagent-fresh" },
		};
		// No phaseId, no user phases → falls through to plan.defaults.
		expect(resolveTaskExecutor(g, g.tasks[0])).toBe("subagent-fresh");
	});
});
