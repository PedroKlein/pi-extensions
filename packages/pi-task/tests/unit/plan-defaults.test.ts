/**
 * P1.3 tests: plan/phase/task defaults cascade for all cascadable fields.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	resolveTaskDefaults,
	type PlanGraph,
	type Phase,
} from "../../src/plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, "../../src/index.ts"), "utf-8");

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "P1",
		title: "P1",
		description: "",
		order: 1,
		dependsOn: [],
		annotations: [],
		...overrides,
	};
}

// ─── AC: plan.defaults.constraints cascades to tasks without constraints ───

describe("plan-level defaults cascade", () => {
	it("plan.defaults.constraints appears in resolved.constraints for a task with none set", () => {
		const task = createPlanTask({ id: "t1", title: "T", description: "D", order: 1 });
		const graph: PlanGraph = {
			...createPlanGraph({ name: "cascade", tasks: resolveTaskStatuses([task]) }),
			defaults: { constraints: ["docs-only"] },
		};
		expect(resolveTaskDefaults(graph, graph.tasks[0]).constraints).toEqual(["docs-only"]);
	});

	it("plan.defaults.referenceSkills merges into resolved.referenceSkills", () => {
		const task = createPlanTask({
			id: "t1", title: "T", description: "D", order: 1,
			references: { skills: ["tdd"] },
		});
		const graph: PlanGraph = {
			...createPlanGraph({ name: "cascade", tasks: resolveTaskStatuses([task]) }),
			defaults: { referenceSkills: ["go-dev"] },
		};
		// Task-level (tdd) prepended, then plan (go-dev). No duplicates.
		expect(resolveTaskDefaults(graph, graph.tasks[0]).referenceSkills).toEqual(["tdd", "go-dev"]);
	});
});

// ─── AC: Task overrides phase overrides plan (scalar case) ─────────────────

describe("task > phase > plan priority for scalars", () => {
	it("task.parallelGroup wins over phase.defaults.parallelGroup", () => {
		const phase = makePhase({ defaults: { parallelGroup: "phase-group" } });
		const task = { ...createPlanTask({ id: "t1", title: "T", description: "D", order: 1, parallelGroup: "task-group" }), phaseId: "P1" };
		const graph: PlanGraph = {
			...createPlanGraph({ name: "prio", tasks: resolveTaskStatuses([task]) }),
			phases: [phase],
		};
		expect(resolveTaskDefaults(graph, graph.tasks[0]).parallelGroup).toBe("task-group");
	});

	it("phase.defaults.parallelGroup wins when task has none", () => {
		const phase = makePhase({ defaults: { parallelGroup: "phase-group" } });
		const task = { ...createPlanTask({ id: "t1", title: "T", description: "D", order: 1 }), phaseId: "P1" };
		const graph: PlanGraph = {
			...createPlanGraph({ name: "prio", tasks: resolveTaskStatuses([task]) }),
			phases: [phase],
		};
		expect(resolveTaskDefaults(graph, graph.tasks[0]).parallelGroup).toBe("phase-group");
	});
});

// ─── Array-merge semantics: concat + dedupe ────────────────────────────────

describe("array cascade: concat + dedupe (task first)", () => {
	it("concatenates task → phase → plan and dedupes by string equality", () => {
		const phase = makePhase({ defaults: { constraints: ["shared-lock", "docs-only"] } });
		const task = {
			...createPlanTask({
				id: "t1", title: "T", description: "D", order: 1,
				constraints: ["task-only", "docs-only"],
			}),
			phaseId: "P1",
		};
		const graph: PlanGraph = {
			...createPlanGraph({ name: "merge", tasks: resolveTaskStatuses([task]) }),
			phases: [phase],
			defaults: { constraints: ["plan-wide", "docs-only"] },
		};
		// Task first (task-only, docs-only), then phase (shared-lock; docs-only skipped),
		// then plan (plan-wide; docs-only skipped).
		expect(resolveTaskDefaults(graph, graph.tasks[0]).constraints).toEqual([
			"task-only",
			"docs-only",
			"shared-lock",
			"plan-wide",
		]);
	});

	it("acceptanceCriteria cascade concats and dedupes", () => {
		const phase = makePhase({ defaults: { acceptanceCriteria: ["AC: phase-level"] } });
		const task = {
			...createPlanTask({
				id: "t1", title: "T", description: "D", order: 1,
				acceptanceCriteria: ["AC: task-level"],
			}),
			phaseId: "P1",
		};
		const graph: PlanGraph = {
			...createPlanGraph({ name: "ac-merge", tasks: resolveTaskStatuses([task]) }),
			phases: [phase],
			defaults: { acceptanceCriteria: ["AC: plan-wide"] },
		};
		expect(resolveTaskDefaults(graph, graph.tasks[0]).acceptanceCriteria).toEqual([
			"AC: task-level",
			"AC: phase-level",
			"AC: plan-wide",
		]);
	});
});

// ─── AC: plan_tasks get --verbose returns raw + resolved ───────────────────

describe("plan_tasks get --verbose (raw + resolved)", () => {
	it("descriptor advertises the `verbose` boolean param", () => {
		expect(INDEX_SRC).toContain("verbose: Type.Optional(Type.Boolean(");
	});

	it("case `get` returns `resolved` in details when verbose=true (source anchor)", () => {
		// The verbose branch reads `resolveTaskDefaults(activePlan, task)` and puts it under `details.resolved`.
		expect(INDEX_SRC).toContain("resolveTaskDefaults(activePlan, task)");
		expect(INDEX_SRC).toContain("details.resolved = resolved");
	});

	it("both raw and resolved keys are visible in the get response contract (JSON-schema style shape)", () => {
		// The response shape: { details: { task, resolved } }. Both `task` and
		// `resolved` are keys inside `details`. Source-level anchor:
		expect(INDEX_SRC).toContain("details: Record<string, unknown> = { task }");
	});
});
