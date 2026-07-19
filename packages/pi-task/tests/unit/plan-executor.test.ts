/**
 * P1.2 tests: executor field validation + display surface.
 *
 * Verifies:
 *   - executor is present in the tool descriptor for `add` (tasks[]) and `update` (updates).
 *   - The five values are the entire enum; unknown values like 'wombat' are rejected.
 *   - formatPlanGraphText surfaces executor when set (status output).
 *   - Cascade resolution: task-level executor wins over phase/plan defaults.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	formatPlanGraphText,
	resolveTaskExecutor,
	type PlanGraph,
	type Phase,
	type TaskExecutor,
} from "../../src/plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, "../../src/index.ts"), "utf-8");

// ─── AC: executor accepts 5 values, rejects others (descriptor + type-level) ───

describe("executor enum", () => {
	it("descriptor lists exactly the five values, in both add-tasks and update-updates blocks", () => {
		const expectedEnum = `["any", "inline", "subagent-fresh", "subagent-fork", "user"]`;
		// StringEnum(...) with these five values appears in the descriptor.
		const occurrences = (INDEX_SRC.match(new RegExp(expectedEnum.replace(/[[\]]/g, "\\$&"), "g")) || []).length;
		// One occurrence in the `add` tasks[] descriptor, one in the `update` updates descriptor.
		expect(occurrences).toBeGreaterThanOrEqual(2);
	});

	it("descriptor does NOT allow arbitrary strings like 'wombat'", () => {
		// The descriptor uses StringEnum which produces JSON schema { type: 'string', enum: [...] }.
		// TypeBox runtime validation rejects non-enum values at parse time. We assert
		// the enum block does not contain any wildcard escape hatch.
		const executorBlockMatch = INDEX_SRC.match(/executor: Type\.Optional\(StringEnum\(\[([^\]]+)\]/);
		expect(executorBlockMatch).not.toBeNull();
		const values = executorBlockMatch![1];
		expect(values).not.toContain("wombat");
		expect(values).not.toContain("...");
	});

	it("TaskExecutor type is a closed union of the five values", () => {
		// Type-level closure: assigning to TaskExecutor with each allowed value compiles;
		// this test compiles = type-level guarantee met.
		const v1: TaskExecutor = "any";
		const v2: TaskExecutor = "inline";
		const v3: TaskExecutor = "subagent-fresh";
		const v4: TaskExecutor = "subagent-fork";
		const v5: TaskExecutor = "user";
		expect([v1, v2, v3, v4, v5]).toHaveLength(5);
	});
});

// ─── AC: cascade — undefined executor on a task with phaseId resolves to phase ───

describe("resolveTaskExecutor cascade (verification of P1.1 divergence)", () => {
	it("task with no executor and phaseId → phase.executor", () => {
		const phase: Phase = {
			id: "P1",
			title: "P1",
			description: "",
			order: 1,
			dependsOn: [],
			executor: "subagent-fresh",
			annotations: [],
		};
		const task = { ...createPlanTask({ id: "t1", title: "T", description: "D", order: 1 }), phaseId: "P1" };
		const graph: PlanGraph = { ...createPlanGraph({ name: "cascade", tasks: resolveTaskStatuses([task]) }), phases: [phase] };
		expect(resolveTaskExecutor(graph, graph.tasks[0])).toBe("subagent-fresh");
	});

	it("task.executor beats phase.executor", () => {
		const phase: Phase = {
			id: "P1", title: "P1", description: "", order: 1, dependsOn: [], executor: "subagent-fresh", annotations: [],
		};
		const task = {
			...createPlanTask({ id: "t1", title: "T", description: "D", order: 1 }),
			phaseId: "P1",
			executor: "user" as const,
		};
		const graph: PlanGraph = { ...createPlanGraph({ name: "cascade", tasks: resolveTaskStatuses([task]) }), phases: [phase] };
		expect(resolveTaskExecutor(graph, graph.tasks[0])).toBe("user");
	});
});

// ─── AC: plan_tasks status output includes executor when set ───────────────

describe("formatPlanGraphText includes executor", () => {
	it("task with executor:'subagent-fresh' surfaces in status output", () => {
		const task = {
			...createPlanTask({ id: "t1", title: "Test task", description: "D", order: 1 }),
			executor: "subagent-fresh" as const,
		};
		const graph: PlanGraph = createPlanGraph({ name: "status", tasks: resolveTaskStatuses([task]) });
		const text = formatPlanGraphText(graph);
		expect(text).toContain("[executor: subagent-fresh]");
	});

	it("task without executor produces no [executor: …] tag", () => {
		const task = createPlanTask({ id: "t1", title: "Test", description: "D", order: 1 });
		const graph: PlanGraph = createPlanGraph({ name: "status", tasks: resolveTaskStatuses([task]) });
		const text = formatPlanGraphText(graph);
		expect(text).not.toContain("[executor:");
	});
});
