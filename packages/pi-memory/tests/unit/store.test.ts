import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/store.js";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
  store = new MemoryStore(join(tmpDir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Stats ───────────────────────────────────────────────────────────

describe("stats", () => {
  it("returns zeros on empty store", () => {
    const s = store.stats();
    expect(s.semantic).toBe(0);
    expect(s.lessons).toBe(0);
    expect(s.events).toBe(0);
  });

  it("reflects added facts and lessons", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    store.addLesson("always use pnpm, not npm", "workflow", "user", false);
    const s = store.stats();
    expect(s.semantic).toBe(1);
    expect(s.lessons).toBe(1);
  });
});

// ─── Semantic facts ──────────────────────────────────────────────────

describe("semantic facts", () => {
  it("sets and gets a fact", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    const entry = store.getSemantic("pref.editor");
    expect(entry).toBeDefined();
    expect(entry!.value).toBe("neovim");
    expect(entry!.confidence).toBe(0.9);
    expect(entry!.source).toBe("user");
  });

  it("normalises key to lowercase", () => {
    store.setSemantic("Pref.Editor", "neovim", 0.9, "user");
    const entry = store.getSemantic("pref.editor");
    expect(entry).toBeDefined();
    expect(entry!.value).toBe("neovim");
  });

  it("returns undefined for missing key", () => {
    expect(store.getSemantic("does.not.exist")).toBeUndefined();
  });

  it("updates existing fact with higher confidence", () => {
    store.setSemantic("pref.editor", "vim", 0.7, "consolidation");
    store.setSemantic("pref.editor", "neovim", 0.95, "user");
    const entry = store.getSemantic("pref.editor");
    expect(entry!.value).toBe("neovim");
    expect(entry!.confidence).toBe(0.95);
  });

  it("does NOT update when incoming confidence is lower", () => {
    store.setSemantic("pref.editor", "neovim", 0.95, "user");
    store.setSemantic("pref.editor", "vim", 0.5, "consolidation");
    const entry = store.getSemantic("pref.editor");
    expect(entry!.value).toBe("neovim"); // higher confidence wins
  });

  it("deletes an existing fact", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    const deleted = store.deleteSemantic("pref.editor");
    expect(deleted).toBe(true);
    expect(store.getSemantic("pref.editor")).toBeUndefined();
  });

  it("returns false when deleting a missing key", () => {
    expect(store.deleteSemantic("does.not.exist")).toBe(false);
  });

  it("lists all facts ordered by updated_at desc", () => {
    store.setSemantic("pref.a", "alpha", 0.9, "user");
    store.setSemantic("pref.b", "beta", 0.8, "user");
    const list = store.listSemantic();
    expect(list.length).toBe(2);
    // Keys should be present
    const keys = list.map(e => e.key);
    expect(keys).toContain("pref.a");
    expect(keys).toContain("pref.b");
  });

  it("lists facts filtered by prefix", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    store.setSemantic("tool.grep", "prefer ripgrep", 0.9, "user");
    const prefs = store.listSemantic("pref.");
    expect(prefs.length).toBe(1);
    expect(prefs[0].key).toBe("pref.editor");
  });

  it("searches facts by query", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    store.setSemantic("tool.grep", "prefer ripgrep", 0.9, "user");
    const results = store.searchSemantic("neovim");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toBe("pref.editor");
  });
});

// ─── Lessons ─────────────────────────────────────────────────────────

describe("lessons", () => {
  it("adds a positive lesson", () => {
    const result = store.addLesson("always use pnpm, not npm", "workflow", "user", false);
    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();
  });

  it("adds a negative lesson (correction)", () => {
    const result = store.addLesson("never use echo >> for file insertion", "workflow", "user", true);
    expect(result.success).toBe(true);
    const lesson = store.getLesson(result.id!);
    expect(lesson!.negative).toBe(true);
  });

  it("deduplicates exact-match lessons (case-insensitive)", () => {
    store.addLesson("always use pnpm, not npm", "workflow", "user", false);
    const dup = store.addLesson("Always use pnpm, not npm", "workflow", "user", false);
    expect(dup.success).toBe(false);
    expect(dup.reason).toBe("duplicate");
  });

  it("deduplicates similar lessons via Jaccard ≥ 0.7", () => {
    store.addLesson("prefer ripgrep over grep for file search", "workflow", "user", false);
    // Very similar (only one word changed)
    const similar = store.addLesson("prefer ripgrep over grep for code search", "workflow", "user", false);
    // Jaccard similarity is high enough to trigger dedup
    expect(similar.success).toBe(false);
  });

  it("allows distinct lessons in the same category", () => {
    const r1 = store.addLesson("use pnpm not npm", "workflow", "user", false);
    const r2 = store.addLesson("always run typecheck before publishing", "workflow", "user", false);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it("lists all lessons", () => {
    store.addLesson("lesson one", "general", "user", false);
    store.addLesson("lesson two", "workflow", "user", false);
    const lessons = store.listLessons();
    expect(lessons.length).toBe(2);
  });

  it("lists lessons filtered by category", () => {
    store.addLesson("lesson one", "general", "user", false);
    store.addLesson("lesson two", "workflow", "user", false);
    const workflow = store.listLessons("workflow");
    expect(workflow.length).toBe(1);
    expect(workflow[0].rule).toBe("lesson two");
  });

  it("soft-deletes a lesson by full ID", () => {
    const r = store.addLesson("delete me", "general", "user", false);
    const deleted = store.deleteLesson(r.id!);
    expect(deleted).toBe(true);
    expect(store.listLessons().length).toBe(0);
  });

  it("soft-deletes a lesson by ID prefix", () => {
    const r = store.addLesson("delete me by prefix", "general", "user", false);
    const prefix = r.id!.slice(0, 8);
    const deleted = store.deleteLesson(prefix);
    expect(deleted).toBe(true);
    expect(store.listLessons().length).toBe(0);
  });

  it("returns false when deleting a non-existent lesson", () => {
    expect(store.deleteLesson("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("deleted lessons do not appear in listLessons", () => {
    const r = store.addLesson("ephemeral lesson", "general", "user", false);
    store.deleteLesson(r.id!);
    const list = store.listLessons();
    expect(list.find(l => l.id === r.id)).toBeUndefined();
  });
});

// ─── Memory stats ────────────────────────────────────────────────────

describe("stats counts deleted lessons correctly", () => {
  it("excludes soft-deleted lessons from count", () => {
    const r = store.addLesson("will be deleted", "general", "user", false);
    expect(store.stats().lessons).toBe(1);
    store.deleteLesson(r.id!);
    expect(store.stats().lessons).toBe(0);
  });
});

// ─── Pinning ─────────────────────────────────────────────────────────

describe("pinning", () => {
  it("pin marks a fact as pinned", () => {
    store.setSemantic("pref.code_style", "simple", 0.9, "user");
    const pinned = store.pin("pref.code_style");
    expect(pinned).toBe(true);
    const list = store.listPinned();
    expect(list.length).toBe(1);
    expect(list[0].key).toBe("pref.code_style");
  });

  it("unpin removes the pin", () => {
    store.setSemantic("pref.code_style", "simple", 0.9, "user");
    store.pin("pref.code_style");
    const unpinned = store.unpin("pref.code_style");
    expect(unpinned).toBe(true);
    expect(store.listPinned().length).toBe(0);
  });

  it("pin returns false for non-existent key", () => {
    expect(store.pin("does.not.exist")).toBe(false);
  });

  it("listPinned returns only pinned facts ordered by key", () => {
    store.setSemantic("pref.b", "beta", 0.9, "user");
    store.setSemantic("pref.a", "alpha", 0.9, "user");
    store.setSemantic("pref.c", "gamma", 0.9, "user");
    store.pin("pref.b");
    store.pin("pref.a");
    const pinned = store.listPinned();
    expect(pinned.length).toBe(2);
    expect(pinned[0].key).toBe("pref.a");
    expect(pinned[1].key).toBe("pref.b");
  });
});
