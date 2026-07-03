import { describe, it, expect, beforeEach } from "vitest";
import {
  GLOBAL_REPO_ID,
  WORK_REPO_ID,
  REVIEW_REPO_ID,
  TASK_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  STATUS_FILTERS,
  GLOBAL_TYPES,
  createTask,
  getTaskRepoId,
  getNextIdForScope,
  isGlobalType,
  shortRepoName,
  getTasksForRepoWithGlobals,
  getTasksForScope,
  getAllScopes,
  getTaskUrgency,
  sortTasksByUrgency,
  filterByStatus,
  getTasksForType,
  getCounters,
  type Task,
  type TaskType,
  type StatusFilter,
} from "../../src/model.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: number; title: string; repoId: string }): Task {
  const now = Date.now();
  return {
    status: "open",
    type: "chore",
    priority: "medium",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

describe("constants", () => {
  it("TASK_TYPES contains all 6 types", () => {
    expect(TASK_TYPES).toContain("feature");
    expect(TASK_TYPES).toContain("bug");
    expect(TASK_TYPES).toContain("chore");
    expect(TASK_TYPES).toContain("research");
    expect(TASK_TYPES).toContain("review");
    expect(TASK_TYPES).toContain("personal");
    expect(TASK_TYPES).toHaveLength(6);
  });

  it("TASK_PRIORITIES contains all 3 priorities", () => {
    expect(TASK_PRIORITIES).toContain("low");
    expect(TASK_PRIORITIES).toContain("medium");
    expect(TASK_PRIORITIES).toContain("high");
    expect(TASK_PRIORITIES).toHaveLength(3);
  });

  it("TASK_STATUSES contains all 3 statuses", () => {
    expect(TASK_STATUSES).toContain("open");
    expect(TASK_STATUSES).toContain("blocked");
    expect(TASK_STATUSES).toContain("done");
    expect(TASK_STATUSES).toHaveLength(3);
  });

  it("STATUS_FILTERS contains expected values", () => {
    expect(STATUS_FILTERS).toContain("active");
    expect(STATUS_FILTERS).toContain("open");
    expect(STATUS_FILTERS).toContain("blocked");
    expect(STATUS_FILTERS).toContain("done");
    expect(STATUS_FILTERS).toContain("all");
  });

  it("GLOBAL_TYPES includes personal and review", () => {
    expect(GLOBAL_TYPES).toContain("personal");
    expect(GLOBAL_TYPES).toContain("review");
  });
});

// ── getTaskRepoId ──────────────────────────────────────────────────────────

describe("getTaskRepoId", () => {
  it("routes personal to GLOBAL_REPO_ID", () => {
    expect(getTaskRepoId("personal", "pedroklein__myrepo")).toBe(GLOBAL_REPO_ID);
  });

  it("routes review to REVIEW_REPO_ID", () => {
    expect(getTaskRepoId("review", "pedroklein__myrepo")).toBe(REVIEW_REPO_ID);
  });

  it("routes feature to currentRepoId", () => {
    expect(getTaskRepoId("feature", "pedroklein__myrepo")).toBe("pedroklein__myrepo");
  });

  it("routes bug to currentRepoId", () => {
    expect(getTaskRepoId("bug", "some-repo")).toBe("some-repo");
  });

  it("routes chore to currentRepoId", () => {
    expect(getTaskRepoId("chore", "other")).toBe("other");
  });

  it("routes research to currentRepoId", () => {
    expect(getTaskRepoId("research", "other")).toBe("other");
  });
});

// ── isGlobalType ───────────────────────────────────────────────────────────

describe("isGlobalType", () => {
  it("returns true for personal", () => {
    expect(isGlobalType("personal")).toBe(true);
  });

  it("returns true for review", () => {
    expect(isGlobalType("review")).toBe(true);
  });

  it("returns false for feature", () => {
    expect(isGlobalType("feature")).toBe(false);
  });

  it("returns false for chore", () => {
    expect(isGlobalType("chore")).toBe(false);
  });
});

// ── createTask ─────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("creates a task with defaults", () => {
    const task = createTask(1, "Fix bug", "myrepo");
    expect(task.id).toBe(1);
    expect(task.title).toBe("Fix bug");
    expect(task.status).toBe("open");
    expect(task.type).toBe("chore");
    expect(task.priority).toBe("medium");
    expect(task.repoId).toBe("myrepo");
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
  });

  it("overrides type from partial", () => {
    const task = createTask(1, "New feature", "myrepo", { type: "feature" });
    expect(task.type).toBe("feature");
  });

  it("routes personal type to global scope", () => {
    const task = createTask(1, "Buy groceries", "myrepo", { type: "personal" });
    expect(task.repoId).toBe(GLOBAL_REPO_ID);
  });

  it("routes review type to reviews scope", () => {
    const task = createTask(1, "Review PR #42", "myrepo", { type: "review" });
    expect(task.repoId).toBe(REVIEW_REPO_ID);
  });

  it("applies priority from partial", () => {
    const task = createTask(1, "Urgent fix", "myrepo", { priority: "high" });
    expect(task.priority).toBe("high");
  });

  it("applies dueDate from partial", () => {
    const task = createTask(1, "Deadline task", "myrepo", { dueDate: "2025-12-31" });
    expect(task.dueDate).toBe("2025-12-31");
  });

  it("preserves createdAt from partial", () => {
    const past = Date.now() - 100000;
    const task = createTask(1, "Old task", "myrepo", { createdAt: past });
    expect(task.createdAt).toBe(past);
  });

  it("always sets updatedAt to now even if partial provides it", () => {
    const before = Date.now();
    const task = createTask(1, "Task", "myrepo", { updatedAt: 0 });
    expect(task.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── getNextIdForScope ──────────────────────────────────────────────────────

describe("getNextIdForScope", () => {
  it("returns 1 for empty scope", () => {
    expect(getNextIdForScope([], "myrepo")).toBe(1);
  });

  it("returns max+1 for non-empty scope", () => {
    const tasks = [
      makeTask({ id: 1, title: "a", repoId: "myrepo" }),
      makeTask({ id: 3, title: "b", repoId: "myrepo" }),
    ];
    expect(getNextIdForScope(tasks, "myrepo")).toBe(4);
  });

  it("only counts tasks in the given scope", () => {
    const tasks = [
      makeTask({ id: 10, title: "a", repoId: "other" }),
      makeTask({ id: 1, title: "b", repoId: "myrepo" }),
    ];
    expect(getNextIdForScope(tasks, "myrepo")).toBe(2);
  });

  it("returns 1 when scope has no tasks", () => {
    const tasks = [makeTask({ id: 5, title: "a", repoId: "other" })];
    expect(getNextIdForScope(tasks, "myrepo")).toBe(1);
  });
});

// ── shortRepoName ──────────────────────────────────────────────────────────

describe("shortRepoName", () => {
  it("maps global to personal", () => {
    expect(shortRepoName(GLOBAL_REPO_ID)).toBe("personal");
  });

  it("maps work to work", () => {
    expect(shortRepoName(WORK_REPO_ID)).toBe("work");
  });

  it("maps reviews to reviews", () => {
    expect(shortRepoName(REVIEW_REPO_ID)).toBe("reviews");
  });

  it("extracts repo part from owner__repo slug", () => {
    expect(shortRepoName("pedroklein__dotfiles")).toBe("dotfiles");
  });

  it("handles repo slugs with dashes", () => {
    expect(shortRepoName("strat__kms-lite")).toBe("kms-lite");
  });

  it("returns raw string for unrecognized formats", () => {
    expect(shortRepoName("somerepo")).toBe("somerepo");
  });
});

// ── getTasksForRepoWithGlobals ─────────────────────────────────────────────

describe("getTasksForRepoWithGlobals", () => {
  const tasks: Task[] = [
    makeTask({ id: 1, title: "a", repoId: "myrepo" }),
    makeTask({ id: 2, title: "b", repoId: "other" }),
    makeTask({ id: 3, title: "c", repoId: GLOBAL_REPO_ID }),
    makeTask({ id: 4, title: "d", repoId: REVIEW_REPO_ID }),
    makeTask({ id: 5, title: "e", repoId: WORK_REPO_ID }),
  ];

  it("returns repo tasks plus all global scopes", () => {
    const result = getTasksForRepoWithGlobals(tasks, "myrepo");
    const ids = result.map((t) => t.id);
    expect(ids).toContain(1); // myrepo
    expect(ids).toContain(3); // global
    expect(ids).toContain(4); // reviews
    expect(ids).toContain(5); // work
    expect(ids).not.toContain(2); // other repo excluded
  });

  it("returns only global tasks when repoId is GLOBAL_REPO_ID", () => {
    const result = getTasksForRepoWithGlobals(tasks, GLOBAL_REPO_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(3);
  });

  it("returns only review tasks when repoId is REVIEW_REPO_ID", () => {
    const result = getTasksForRepoWithGlobals(tasks, REVIEW_REPO_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(4);
  });
});

// ── getTasksForScope ───────────────────────────────────────────────────────

describe("getTasksForScope", () => {
  it("returns only tasks matching the scope", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "a", repoId: "myrepo" }),
      makeTask({ id: 2, title: "b", repoId: "other" }),
    ];
    const result = getTasksForScope(tasks, "myrepo");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});

// ── getAllScopes ───────────────────────────────────────────────────────────

describe("getAllScopes", () => {
  it("always includes special scopes", () => {
    const scopes = getAllScopes([], "myrepo");
    expect(scopes).toContain("myrepo");
    expect(scopes).toContain(GLOBAL_REPO_ID);
    expect(scopes).toContain(WORK_REPO_ID);
    expect(scopes).toContain(REVIEW_REPO_ID);
  });

  it("puts currentRepoId first", () => {
    const scopes = getAllScopes([], "myrepo");
    expect(scopes[0]).toBe("myrepo");
  });

  it("deduplicates when currentRepoId is a special scope", () => {
    const scopes = getAllScopes([], GLOBAL_REPO_ID);
    const globalCount = scopes.filter((s) => s === GLOBAL_REPO_ID).length;
    expect(globalCount).toBe(1);
  });
});

// ── getTaskUrgency ─────────────────────────────────────────────────────────

describe("getTaskUrgency", () => {
  it("returns done for done tasks", () => {
    const task = makeTask({ id: 1, title: "t", repoId: "r", status: "done" });
    expect(getTaskUrgency(task)).toBe("done");
  });

  it("returns blocked for blocked tasks", () => {
    const task = makeTask({ id: 1, title: "t", repoId: "r", status: "blocked" });
    expect(getTaskUrgency(task)).toBe("blocked");
  });

  it("returns normal for open task with no due date", () => {
    const task = makeTask({ id: 1, title: "t", repoId: "r" });
    expect(getTaskUrgency(task)).toBe("normal");
  });

  it("returns overdue for task with past due date", () => {
    const task = makeTask({ id: 1, title: "t", repoId: "r", dueDate: "2000-01-01" });
    expect(getTaskUrgency(task)).toBe("overdue");
  });

  it("returns due-soon for task due within 48 hours", () => {
    const tomorrow = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const dateStr = tomorrow.toISOString().split("T")[0];
    const task = makeTask({ id: 1, title: "t", repoId: "r", dueDate: dateStr });
    expect(getTaskUrgency(task)).toBe("due-soon");
  });

  it("returns normal for task due in the future", () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const dateStr = farFuture.toISOString().split("T")[0];
    const task = makeTask({ id: 1, title: "t", repoId: "r", dueDate: dateStr });
    expect(getTaskUrgency(task)).toBe("normal");
  });
});

// ── sortTasksByUrgency ─────────────────────────────────────────────────────

describe("sortTasksByUrgency", () => {
  it("sorts overdue before due-soon before normal before done", () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().split("T")[0];

    const tasks: Task[] = [
      makeTask({ id: 1, title: "done task", repoId: "r", status: "done" }),
      makeTask({ id: 2, title: "normal task", repoId: "r", dueDate: farFuture }),
      makeTask({ id: 3, title: "overdue task", repoId: "r", dueDate: "2000-01-01" }),
      makeTask({ id: 4, title: "due soon task", repoId: "r", dueDate: soon }),
    ];

    const sorted = sortTasksByUrgency(tasks);
    expect(sorted[0].id).toBe(3); // overdue
    expect(sorted[1].id).toBe(4); // due-soon
    expect(sorted[2].id).toBe(2); // normal
    expect(sorted[3].id).toBe(1); // done
  });

  it("sorts high priority before medium before low within same urgency", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "low", repoId: "r", priority: "low" }),
      makeTask({ id: 2, title: "high", repoId: "r", priority: "high" }),
      makeTask({ id: 3, title: "medium", repoId: "r", priority: "medium" }),
    ];
    const sorted = sortTasksByUrgency(tasks);
    expect(sorted[0].id).toBe(2); // high
    expect(sorted[1].id).toBe(3); // medium
    expect(sorted[2].id).toBe(1); // low
  });

  it("does not mutate the original array", () => {
    const tasks: Task[] = [
      makeTask({ id: 2, title: "b", repoId: "r" }),
      makeTask({ id: 1, title: "a", repoId: "r" }),
    ];
    sortTasksByUrgency(tasks);
    expect(tasks[0].id).toBe(2); // unchanged
  });
});

// ── filterByStatus ─────────────────────────────────────────────────────────

describe("filterByStatus", () => {
  const tasks: Task[] = [
    makeTask({ id: 1, title: "a", repoId: "r", status: "open" }),
    makeTask({ id: 2, title: "b", repoId: "r", status: "blocked" }),
    makeTask({ id: 3, title: "c", repoId: "r", status: "done" }),
  ];

  it("active returns non-done tasks", () => {
    const result = filterByStatus(tasks, "active");
    expect(result.map((t) => t.id)).toEqual([1, 2]);
  });

  it("open returns only open tasks", () => {
    const result = filterByStatus(tasks, "open");
    expect(result.map((t) => t.id)).toEqual([1]);
  });

  it("blocked returns only blocked tasks", () => {
    const result = filterByStatus(tasks, "blocked");
    expect(result.map((t) => t.id)).toEqual([2]);
  });

  it("done returns only done tasks", () => {
    const result = filterByStatus(tasks, "done");
    expect(result.map((t) => t.id)).toEqual([3]);
  });

  it("all returns everything", () => {
    const result = filterByStatus(tasks, "all");
    expect(result).toHaveLength(3);
  });
});

// ── getCounters ────────────────────────────────────────────────────────────

describe("getCounters", () => {
  it("counts task urgency categories", () => {
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().split("T")[0];
    const tasks: Task[] = [
      makeTask({ id: 1, title: "overdue", repoId: "r", dueDate: "2000-01-01" }),
      makeTask({ id: 2, title: "due-soon", repoId: "r", dueDate: soon }),
      makeTask({ id: 3, title: "open", repoId: "r" }),
      makeTask({ id: 4, title: "blocked", repoId: "r", status: "blocked" }),
      makeTask({ id: 5, title: "done", repoId: "r", status: "done" }),
    ];
    const counters = getCounters(tasks);
    expect(counters.overdue).toBe(1);
    expect(counters.dueSoon).toBe(1);
    expect(counters.open).toBe(1);
    expect(counters.blocked).toBe(1);
    expect(counters.done).toBe(1);
  });

  it("returns all zeros for empty array", () => {
    const counters = getCounters([]);
    expect(counters.overdue).toBe(0);
    expect(counters.dueSoon).toBe(0);
    expect(counters.open).toBe(0);
    expect(counters.blocked).toBe(0);
    expect(counters.done).toBe(0);
  });
});

// ── getTasksForType ────────────────────────────────────────────────────────

describe("getTasksForType", () => {
  it("returns only tasks of the given type", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "a", repoId: "r", type: "bug" }),
      makeTask({ id: 2, title: "b", repoId: "r", type: "feature" }),
      makeTask({ id: 3, title: "c", repoId: "r", type: "bug" }),
    ];
    const result = getTasksForType(tasks, "bug", "all");
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.type === "bug")).toBe(true);
  });

  it("applies status filter", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "a", repoId: "r", type: "chore", status: "open" }),
      makeTask({ id: 2, title: "b", repoId: "r", type: "chore", status: "done" }),
    ];
    const result = getTasksForType(tasks, "chore", "active");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});
