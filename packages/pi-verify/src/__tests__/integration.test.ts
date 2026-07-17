/**
 * Integration test for the freeze → verify flow.
 * Tests the pi-task plan model freeze/criteria logic directly.
 */
import { describe, it, expect } from "vitest";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	freezeTask,
	freezeAllTasks,
	unfreezeTask,
	addAcceptanceCriteria,
	updateTask,
} from "../../../pi-task/src/plan.js";

describe("Freeze → Verify integration", () => {
	function makeTestPlan() {
		const tasks = [
			createPlanTask({
				id: "task-1",
				title: "Implement feature",
				description: "Build the thing",
				order: 1,
				acceptanceCriteria: [
					"AC: User can create tasks. Verify: POST /tasks returns 201.",
					"AC: Tasks persist after restart. Verify: Restart server, GET /tasks returns previously created task.",
				],
				references: {
					skills: ["go-dev", "go-testing"],
					files: ["internal/handler.go"],
					docs: ["https://pkg.go.dev/net/http"],
				},
				nonGoals: ["Admin UI — only API"],
				constraints: ["Must not break existing endpoints"],
			}),
			createPlanTask({
				id: "task-2",
				title: "No criteria task",
				description: "This one has no AC",
				order: 2,
			}),
		];

		return createPlanGraph({ name: "test-plan", tasks: resolveTaskStatuses(tasks) });
	}

	describe("Acceptance Criteria", () => {
		it("creates tasks with criteria and references", () => {
			const plan = makeTestPlan();
			const task1 = plan.tasks.find((t) => t.id === "task-1")!;

			expect(task1.acceptanceCriteria).toHaveLength(2);
			expect(task1.references?.skills).toEqual(["go-dev", "go-testing"]);
			expect(task1.references?.files).toEqual(["internal/handler.go"]);
			expect(task1.nonGoals).toEqual(["Admin UI — only API"]);
			expect(task1.constraints).toEqual(["Must not break existing endpoints"]);
		});

		it("adds criteria to existing task", () => {
			const plan = makeTestPlan();
			const updated = addAcceptanceCriteria(plan, "task-2", [
				"AC: New criterion. Verify: check it.",
			]);
			const task2 = updated.tasks.find((t) => t.id === "task-2")!;
			expect(task2.acceptanceCriteria).toHaveLength(1);
		});

		it("appends without replacing existing criteria", () => {
			const plan = makeTestPlan();
			const updated = addAcceptanceCriteria(plan, "task-1", ["AC: Third criterion."]);
			const task1 = updated.tasks.find((t) => t.id === "task-1")!;
			expect(task1.acceptanceCriteria).toHaveLength(3);
		});
	});

	describe("Freeze / Unfreeze", () => {
		it("freezes a task with criteria", () => {
			const plan = makeTestPlan();
			const frozen = freezeTask(plan, "task-1");
			const task1 = frozen.tasks.find((t) => t.id === "task-1")!;
			expect(task1.frozen).toBe(true);
		});

		it("rejects freeze when no criteria exist", () => {
			const plan = makeTestPlan();
			expect(() => freezeTask(plan, "task-2")).toThrow("no acceptance criteria");
		});

		it("freezeAll freezes tasks with criteria, skips others", () => {
			const plan = makeTestPlan();
			const result = freezeAllTasks(plan);
			const task1 = result.graph.tasks.find((t) => t.id === "task-1")!;
			const task2 = result.graph.tasks.find((t) => t.id === "task-2")!;

			expect(task1.frozen).toBe(true);
			expect(task2.frozen).toBeUndefined();
			expect(result.skipped).toContain("task-2");
		});

		it("frozen task blocks criterion updates", () => {
			const plan = makeTestPlan();
			const frozen = freezeTask(plan, "task-1");

			expect(() =>
				updateTask(frozen, "task-1", { acceptanceCriteria: ["replaced"] }),
			).toThrow("frozen");
		});

		it("frozen task blocks addAcceptanceCriteria", () => {
			const plan = makeTestPlan();
			const frozen = freezeTask(plan, "task-1");

			expect(() =>
				addAcceptanceCriteria(frozen, "task-1", ["new criterion"]),
			).toThrow("frozen");
		});

		it("unfreeze allows modification again", () => {
			const plan = makeTestPlan();
			const frozen = freezeTask(plan, "task-1");
			const unfrozen = unfreezeTask(frozen, "task-1");
			const task1 = unfrozen.tasks.find((t) => t.id === "task-1")!;

			expect(task1.frozen).toBe(false);

			// Should not throw now
			const updated = addAcceptanceCriteria(unfrozen, "task-1", ["new criterion"]);
			expect(updated.tasks.find((t) => t.id === "task-1")!.acceptanceCriteria).toHaveLength(3);
		});

		it("freeze is idempotent", () => {
			const plan = makeTestPlan();
			const frozen1 = freezeTask(plan, "task-1");
			const frozen2 = freezeTask(frozen1, "task-1");
			expect(frozen2).toBe(frozen1); // Same reference (no-op)
		});

		it("unfreeze is idempotent", () => {
			const plan = makeTestPlan();
			const unfrozen = unfreezeTask(plan, "task-1");
			expect(unfrozen).toBe(plan); // Already not frozen
		});
	});

	describe("Backward compatibility", () => {
		it("tasks without new fields still work", () => {
			const task = createPlanTask({
				id: "simple",
				title: "Simple task",
				description: "No new fields",
				order: 1,
			});

			expect(task.acceptanceCriteria).toBeUndefined();
			expect(task.frozen).toBeUndefined();
			expect(task.references).toBeUndefined();
			expect(task.nonGoals).toBeUndefined();
			expect(task.constraints).toBeUndefined();
		});

		it("updateTask works without touching new fields", () => {
			const plan = makeTestPlan();
			const updated = updateTask(plan, "task-1", { title: "New title" });
			const task1 = updated.tasks.find((t) => t.id === "task-1")!;

			expect(task1.title).toBe("New title");
			expect(task1.acceptanceCriteria).toHaveLength(2); // Preserved
			expect(task1.references?.skills).toEqual(["go-dev", "go-testing"]); // Preserved
		});
	});
});
