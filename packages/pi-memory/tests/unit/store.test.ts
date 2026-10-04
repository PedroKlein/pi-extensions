import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
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

describe("semantic facts", () => {
  it("sets and gets a fact", () => {
    store.setSemantic("pref.editor", "neovim", 0.9, "user");
    expect(store.getSemantic("pref.editor")).toMatchObject({
      value: "neovim",
      confidence: 0.9,
      source: "user",
    });
  });

  it("normalises keys to lowercase", () => {
    store.setSemantic("Pref.Editor", "neovim", 0.9, "user");
    expect(store.getSemantic("pref.editor")?.value).toBe("neovim");
  });

  it("rejects invalid keys", () => {
    expect(() => store.setSemantic("bad key", "value"))
      .toThrow("Memory key");
  });

  it("rejects credential-shaped values", () => {
    const secret = "tvly-abcdefghijklmnopqrstuvwxyz123456";

    expect(() => store.setSemantic("pref.secret", secret, 0.9, "user"))
      .toThrow("credential");
    expect(store.getSemantic("pref.secret")).toBeUndefined();
  });

  it("lets an explicit user write replace an inferred higher-confidence value", () => {
    store.setSemantic("pref.editor", "vim", 0.99, "consolidation");
    store.setSemantic("pref.editor", "neovim", 0.95, "user");
    expect(store.getSemantic("pref.editor")?.value).toBe("neovim");
  });

  it("does not let a lower-confidence inferred write replace a user value", () => {
    store.setSemantic("pref.editor", "neovim", 0.95, "user");
    store.setSemantic("pref.editor", "vim", 0.5, "consolidation");
    expect(store.getSemantic("pref.editor")?.value).toBe("neovim");
  });

  it("deletes an existing fact", () => {
    store.setSemantic("pref.editor", "neovim");
    expect(store.deleteSemantic("pref.editor")).toBe(true);
    expect(store.getSemantic("pref.editor")).toBeUndefined();
  });

  it("returns false when deleting a missing fact", () => {
    expect(store.deleteSemantic("does.not.exist")).toBe(false);
  });

  it("lists facts in stable key order with pagination", () => {
    store.setSemantic("pref.c", "gamma");
    store.setSemantic("pref.a", "alpha");
    store.setSemantic("pref.b", "beta");

    expect(store.querySemantic({ scope: "all", limit: 2, offset: 0 })).toMatchObject({
      total: 3,
      entries: [{ key: "pref.a" }, { key: "pref.b" }],
    });
    expect(store.querySemantic({ scope: "all", limit: 2, offset: 2 })).toMatchObject({
      total: 3,
      entries: [{ key: "pref.c" }],
    });
  });

  it("scopes queries to global and current-project facts", () => {
    store.setSemantic("pref.editor", "shared editor");
    store.setSemantic("project.alpha.editor", "alpha editor");
    store.setSemantic("project.beta.editor", "beta editor");

    expect(store.querySemantic({ query: "editor", project: "alpha" }).entries.map((entry) => entry.key))
      .toEqual(["pref.editor", "project.alpha.editor"]);
    expect(store.querySemantic({ query: "editor", scope: "global", project: "alpha" }).entries.map((entry) => entry.key))
      .toEqual(["pref.editor"]);
    expect(store.querySemantic({ query: "editor", scope: "all", project: "alpha" }).entries.map((entry) => entry.key))
      .toEqual(["pref.editor", "project.alpha.editor", "project.beta.editor"]);
  });
});

describe("legacy databases", () => {
  it("opens a database with legacy lesson tables without deleting them", () => {
    store.close();
    const dbPath = join(tmpDir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE lessons (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        negative INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO lessons VALUES ('legacy', 'old rule', 'general', 'user', 0, 0, datetime('now'));
    `);
    legacy.close();

    store = new MemoryStore(dbPath);
    store.setSemantic("pref.editor", "neovim");
    expect(store.getSemantic("pref.editor")?.value).toBe("neovim");

    store.close();
    const inspected = new DatabaseSync(dbPath);
    expect((inspected.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count).toBe(1);
    inspected.close();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });
});

describe("pinning", () => {
  it("pins, lists, and unpins facts", () => {
    store.setSemantic("pref.b", "beta");
    store.setSemantic("pref.a", "alpha");
    expect(store.pin("pref.b")).toBe(true);
    expect(store.pin("pref.a")).toBe(true);
    expect(store.listPinned().map((entry) => entry.key)).toEqual(["pref.a", "pref.b"]);
    expect(store.unpin("pref.a")).toBe(true);
    expect(store.listPinned().map((entry) => entry.key)).toEqual(["pref.b"]);
  });

  it("returns false for missing facts", () => {
    expect(store.pin("does.not.exist")).toBe(false);
    expect(store.unpin("does.not.exist")).toBe(false);
  });
});

describe("stats", () => {
  it("counts facts and events", () => {
    store.setSemantic("pref.editor", "neovim");
    expect(store.stats()).toEqual({ semantic: 1, events: 1 });
  });
});
