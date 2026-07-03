import { describe, it, expect } from "vitest";
import {
  createPlanGraph,
  createPlanTask,
  createPlanSubtask,
  resolveTaskStatuses,
  getReadyTasks,
  getNextTask,
  getTaskCounts,
  validatePlanGraph,
  setTaskStatus,
  setSubtaskStatus,
  expandTaskSubtasks,
  updateTask,
  addTaskAnnotation,
  computePlanDiff,
  savePreviousRevision,
  snapshotTasks,
  detectScopeCreep,
  matchTasksByFiles,
  type PlanGraph,
  type PlanTask,
} from "../../src/plan.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTask(id: string, order: number, dependsOn: string[] = []): PlanTask {
  return createPlanTask({ id, title: `Task ${id}`, description: `Desc ${id}`, order, dependsOn });
}

function makeGraph(tasks: PlanTask[]): PlanGraph {
  return createPlanGraph({ name: "test-plan", tasks: resolveTaskStatuses(tasks) });
}

// ─── createPlanGraph ──────────────────────────────────────────────────────

describe("createPlanGraph", () => {
  it("creates a graph with active status and timestamp", () => {
    const g = createPlanGraph({ name: "my-plan" });
    expect(g.status).toBe("active");
    expect(g.name).toBe("my-plan");
    expect(g.id).toContain("my-plan");
    expect(g.tasks).toHaveLength(0);
    expect(g.createdAt).toBeGreaterThan(0);
  });

  it("slugifies name in id", () => {
    const g = createPlanGraph({ name: "Hello World!" });
    expect(g.id).toContain("hello-world");
  });

  it("accepts optional sourceCheckpoint", () => {
    const g = createPlanGraph({ name: "x", sourceCheckpoint: "spdd/canvas.md" });
    expect(g.sourceCheckpoint).toBe("spdd/canvas.md");
  });
});

// ─── createPlanTask ───────────────────────────────────────────────────────

describe("createPlanTask", () => {
  it("creates task with pending status and empty subtasks", () => {
    const t = makeTask("t1", 1);
    expect(t.status).toBe("pending");
    expect(t.subtasks).toHaveLength(0);
    expect(t.annotations).toHaveLength(0);
    expect(t.dependsOn).toHaveLength(0);
  });

  it("stores parallelGroup when provided", () => {
    const t = createPlanTask({ id: "t1", title: "T", description: "D", order: 1, parallelGroup: "wave-1" });
    expect(t.parallelGroup).toBe("wave-1");
  });
});

// ─── resolveTaskStatuses ──────────────────────────────────────────────────

describe("resolveTaskStatuses", () => {
  it("tasks with no deps become ready", () => {
    const tasks = resolveTaskStatuses([makeTask("a", 1), makeTask("b", 2)]);
    expect(tasks.every((t) => t.status === "ready")).toBe(true);
  });

  it("task with unsatisfied dep is blocked", () => {
    const tasks = resolveTaskStatuses([makeTask("a", 1), makeTask("b", 2, ["a"])]);
    const b = tasks.find((t) => t.id === "b")!;
    expect(b.status).toBe("blocked");
  });

  it("task with all deps done becomes ready", () => {
    const a = { ...makeTask("a", 1), status: "done" as const };
    const b = makeTask("b", 2, ["a"]);
    const tasks = resolveTaskStatuses([a, b]);
    const bOut = tasks.find((t) => t.id === "b")!;
    expect(bOut.status).toBe("ready");
  });

  it("does not override done/skipped/in-progress status", () => {
    const a = { ...makeTask("a", 1), status: "done" as const };
    const b = { ...makeTask("b", 2), status: "in-progress" as const };
    const c = { ...makeTask("c", 3), status: "skipped" as const };
    const tasks = resolveTaskStatuses([a, b, c]);
    expect(tasks[0].status).toBe("done");
    expect(tasks[1].status).toBe("in-progress");
    expect(tasks[2].status).toBe("skipped");
  });
});

// ─── getReadyTasks ────────────────────────────────────────────────────────

describe("getReadyTasks", () => {
  it("returns only ready tasks sorted by order", () => {
    const graph = makeGraph([makeTask("a", 2), makeTask("b", 1), makeTask("c", 3, ["a"])]);
    const ready = getReadyTasks(graph);
    expect(ready.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

// ─── getNextTask ──────────────────────────────────────────────────────────

describe("getNextTask", () => {
  it("returns first ready task when no activeTaskId", () => {
    const graph = makeGraph([makeTask("a", 2), makeTask("b", 1)]);
    expect(getNextTask(graph)?.id).toBe("b");
  });

  it("returns active task if set and not terminal", () => {
    const tasks = resolveTaskStatuses([makeTask("a", 1), makeTask("b", 2)]);
    const graph = { ...makeGraph(tasks), activeTaskId: "b" };
    expect(getNextTask(graph)?.id).toBe("b");
  });

  it("falls back to first ready if active task is done", () => {
    const a = { ...makeTask("a", 1), status: "done" as const };
    const b = makeTask("b", 2);
    const tasks = resolveTaskStatuses([a, b]);
    const graph = { ...makeGraph(tasks), activeTaskId: "a" };
    expect(getNextTask(graph)?.id).toBe("b");
  });

  it("returns null when all tasks done", () => {
    const a = { ...makeTask("a", 1), status: "done" as const };
    const graph = makeGraph([a]);
    expect(getNextTask(graph)).toBeNull();
  });
});

// ─── getTaskCounts ────────────────────────────────────────────────────────

describe("getTaskCounts", () => {
  it("counts correctly across statuses", () => {
    const a = { ...makeTask("a", 1), status: "done" as const };
    const b = makeTask("b", 2);                                   // → ready (no deps)
    const c = { ...makeTask("c", 3, ["b"]) };                     // → blocked
    const graph = makeGraph([a, b, c]);
    const counts = getTaskCounts(graph);
    expect(counts.total).toBe(3);
    expect(counts.done).toBe(1);
    expect(counts.ready).toBe(1);
    expect(counts.blocked).toBe(1);
  });
});

// ─── validatePlanGraph ────────────────────────────────────────────────────

describe("validatePlanGraph", () => {
  it("returns no errors for valid graph", () => {
    const graph = makeGraph([makeTask("a", 1), makeTask("b", 2, ["a"])]);
    expect(validatePlanGraph(graph)).toHaveLength(0);
  });

  it("detects duplicate task IDs", () => {
    const graph = makeGraph([makeTask("a", 1), makeTask("a", 2)]);
    const errors = validatePlanGraph(graph);
    expect(errors.some((e) => e.message.includes("Duplicate task ID"))).toBe(true);
  });

  it("detects missing dependency", () => {
    const graph = makeGraph([makeTask("b", 1, ["nonexistent"])]);
    const errors = validatePlanGraph(graph);
    expect(errors.some((e) => e.message.includes("unknown task"))).toBe(true);
  });

  it("detects dependency cycles", () => {
    const a = makeTask("a", 1, ["b"]);
    const b = makeTask("b", 2, ["a"]);
    const graph = makeGraph([a, b]);
    const errors = validatePlanGraph(graph);
    expect(errors.some((e) => e.message.includes("cycle"))).toBe(true);
  });

  it("detects file overlaps in parallel groups", () => {
    const a = createPlanTask({ id: "a", title: "A", description: "D", order: 1, parallelGroup: "g1", files: ["src/x.ts"] });
    const b = createPlanTask({ id: "b", title: "B", description: "D", order: 2, parallelGroup: "g1", files: ["src/x.ts"] });
    const graph = makeGraph([a, b]);
    const errors = validatePlanGraph(graph);
    expect(errors.some((e) => e.message.includes("File overlap"))).toBe(true);
  });
});

// ─── setTaskStatus ────────────────────────────────────────────────────────

describe("setTaskStatus", () => {
  it("marks task done and cascades to sub-tasks", () => {
    const sub = createPlanSubtask({ id: "s1", title: "Sub 1" });
    const task = { ...makeTask("a", 1), subtasks: [sub] };
    const graph = makeGraph([task]);
    const updated = setTaskStatus(graph, "a", "done");
    const updatedTask = updated.tasks.find((t) => t.id === "a")!;
    expect(updatedTask.status).toBe("done");
    expect(updatedTask.subtasks[0].status).toBe("done");
  });

  it("marks task skipped and cascades to sub-tasks", () => {
    const sub = createPlanSubtask({ id: "s1", title: "Sub 1" });
    const task = { ...makeTask("a", 1), subtasks: [sub] };
    const graph = makeGraph([task]);
    const updated = setTaskStatus(graph, "a", "skipped");
    const updatedTask = updated.tasks.find((t) => t.id === "a")!;
    expect(updatedTask.status).toBe("skipped");
    expect(updatedTask.subtasks[0].status).toBe("skipped");
  });

  it("does not cascade when completing task if sub-task already done", () => {
    const sub = createPlanSubtask({ id: "s1", title: "Sub" });
    const doneSub = { ...sub, status: "done" as const };
    const task = { ...makeTask("a", 1), subtasks: [doneSub] };
    const graph = makeGraph([task]);
    const updated = setTaskStatus(graph, "a", "done");
    expect(updated.tasks[0].subtasks[0].status).toBe("done");
  });

  it("unlocks dependent tasks after completing a dep", () => {
    const a = makeTask("a", 1);
    const b = makeTask("b", 2, ["a"]);
    const graph = makeGraph([a, b]);
    const updated = setTaskStatus(graph, "a", "done");
    const bOut = updated.tasks.find((t) => t.id === "b")!;
    expect(bOut.status).toBe("ready");
  });

  it("is a no-op for unknown task ID", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const updated = setTaskStatus(graph, "nonexistent", "done");
    expect(updated.tasks).toEqual(graph.tasks);
  });
});

// ─── setSubtaskStatus ─────────────────────────────────────────────────────

describe("setSubtaskStatus", () => {
  it("updates only the target sub-task", () => {
    const s1 = createPlanSubtask({ id: "s1", title: "Sub 1" });
    const s2 = createPlanSubtask({ id: "s2", title: "Sub 2" });
    const task = { ...makeTask("a", 1), subtasks: [s1, s2] };
    const graph = makeGraph([task]);
    const updated = setSubtaskStatus(graph, "a", "s1", "done");
    const updatedTask = updated.tasks[0];
    expect(updatedTask.subtasks[0].status).toBe("done");
    expect(updatedTask.subtasks[1].status).toBe("pending");
  });
});

// ─── expandTaskSubtasks ───────────────────────────────────────────────────

describe("expandTaskSubtasks", () => {
  it("appends new sub-tasks to existing ones", () => {
    const existing = createPlanSubtask({ id: "s1", title: "Existing" });
    const task = { ...makeTask("a", 1), subtasks: [existing] };
    const graph = makeGraph([task]);
    const newSubs = [createPlanSubtask({ id: "s2", title: "New" })];
    const updated = expandTaskSubtasks(graph, "a", newSubs);
    expect(updated.tasks[0].subtasks).toHaveLength(2);
    expect(updated.tasks[0].subtasks[1].id).toBe("s2");
  });
});

// ─── updateTask ───────────────────────────────────────────────────────────

describe("updateTask", () => {
  it("updates title and description", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const updated = updateTask(graph, "a", { title: "New Title" });
    expect(updated.tasks[0].title).toBe("New Title");
  });

  it("updates parallelGroup", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const updated = updateTask(graph, "a", { parallelGroup: "wave-2" });
    expect(updated.tasks[0].parallelGroup).toBe("wave-2");
  });
});

// ─── addTaskAnnotation ────────────────────────────────────────────────────

describe("addTaskAnnotation", () => {
  it("appends annotation with timestamp", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const before = Date.now();
    const updated = addTaskAnnotation(graph, "a", "This is a note");
    const after = Date.now();
    const ann = updated.tasks[0].annotations[0];
    expect(ann.text).toBe("This is a note");
    expect(ann.timestamp).toBeGreaterThanOrEqual(before);
    expect(ann.timestamp).toBeLessThanOrEqual(after);
  });

  it("accumulates multiple annotations", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const g2 = addTaskAnnotation(graph, "a", "First");
    const g3 = addTaskAnnotation(g2, "a", "Second");
    expect(g3.tasks[0].annotations).toHaveLength(2);
  });
});

// ─── snapshotTasks / computePlanDiff ─────────────────────────────────────

describe("computePlanDiff", () => {
  it("returns empty diff when no previous revision", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    expect(computePlanDiff(graph)).toHaveLength(0);
  });

  it("detects added tasks", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const saved = savePreviousRevision(graph);
    const b = makeTask("b", 2);
    const updated = { ...saved, tasks: resolveTaskStatuses([...saved.tasks, b]) };
    const diff = computePlanDiff(updated);
    expect(diff.some((d) => d.taskId === "b" && d.kind === "added")).toBe(true);
  });

  it("detects removed tasks", () => {
    const a = makeTask("a", 1);
    const b = makeTask("b", 2);
    const graph = makeGraph([a, b]);
    const saved = savePreviousRevision(graph);
    const updated = { ...saved, tasks: resolveTaskStatuses([a]) };
    const diff = computePlanDiff(updated);
    expect(diff.some((d) => d.taskId === "b" && d.kind === "removed")).toBe(true);
  });

  it("detects status changes", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    const saved = savePreviousRevision(graph);
    const updated = setTaskStatus(saved, "a", "done");
    const diff = computePlanDiff(updated);
    const mod = diff.find((d) => d.taskId === "a" && d.kind === "modified");
    expect(mod).toBeDefined();
    expect(mod?.changes?.some((c) => c.includes("status"))).toBe(true);
  });
});

// ─── detectScopeCreep / matchTasksByFiles ─────────────────────────────────

describe("detectScopeCreep", () => {
  it("returns unplanned files", () => {
    const task = createPlanTask({ id: "a", title: "A", description: "D", order: 1, files: ["src/a.ts"] });
    const graph = makeGraph([task]);
    const creep = detectScopeCreep(graph, ["src/a.ts", "src/unplanned.ts"]);
    expect(creep).toEqual(["src/unplanned.ts"]);
  });

  it("returns empty when no file tracking defined", () => {
    const graph = makeGraph([makeTask("a", 1)]);
    expect(detectScopeCreep(graph, ["any/file.ts"])).toHaveLength(0);
  });
});

describe("matchTasksByFiles", () => {
  it("matches tasks where all listed files were edited", () => {
    const task = createPlanTask({ id: "a", title: "A", description: "D", order: 1, files: ["src/a.ts", "src/b.ts"] });
    const graph = makeGraph([task]);
    const matches = matchTasksByFiles(graph, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(matches).toContain("a");
  });

  it("does not match tasks where only some files edited", () => {
    const task = createPlanTask({ id: "a", title: "A", description: "D", order: 1, files: ["src/a.ts", "src/b.ts"] });
    const graph = makeGraph([task]);
    const matches = matchTasksByFiles(graph, ["src/a.ts"]);
    expect(matches).not.toContain("a");
  });

  it("skips done tasks", () => {
    const task = { ...createPlanTask({ id: "a", title: "A", description: "D", order: 1, files: ["src/a.ts"] }), status: "done" as const };
    const graph = makeGraph([task]);
    expect(matchTasksByFiles(graph, ["src/a.ts"])).toHaveLength(0);
  });
});
