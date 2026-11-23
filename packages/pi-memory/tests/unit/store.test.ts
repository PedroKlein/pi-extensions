import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  vi.restoreAllMocks();
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function createLegacySemantic(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE semantic (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO semantic (key, value) VALUES ('pref.editor', 'legacy editor');
  `);
  legacy.close();
}

describe("store initialization", () => {
  it.each([5, 6, 261])("retries confirmed SQLite busy/locked (%s) on the same connection", (errcode) => {
    const exec = DatabaseSync.prototype.exec;
    let attempts = 0;
    const calls = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql === "PRAGMA journal_mode = WAL" && attempts++ === 0) {
        throw Object.assign(new Error("contention"), { code: "ERR_SQLITE_ERROR", errcode });
      }
      return exec.call(this, sql);
    });
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const opened = new MemoryStore(join(tmpDir, "retry.db"));
    try {
      expect(attempts).toBe(2);
      expect(wait).toHaveBeenCalledOnce();
      const walCalls = calls.mock.calls.flatMap(([sql], i) => sql === "PRAGMA journal_mode = WAL" ? [i] : []);
      expect(calls.mock.calls[0][0]).toBe("PRAGMA busy_timeout = 5000");
      expect(calls.mock.contexts[walCalls[0]]).toBe(calls.mock.contexts[walCalls[1]]);
      expect(opened.stats()).toEqual({ semantic: 0, events: 0 });
    } finally { opened.close(); }
  });

  it("bounds WAL retries and propagates the original SQLite contention error", () => {
    const failure = Object.assign(new Error("locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql === "PRAGMA journal_mode = WAL") throw failure;
      return exec.call(this, sql);
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(5_001);
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => new MemoryStore(join(tmpDir, "busy.db"))).toThrow(failure);
    expect(wait).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not retry SQLite errors classified only by their text", () => {
    const failure = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql === "PRAGMA journal_mode = WAL") throw failure;
      return exec.call(this, sql);
    });
    const wait = vi.spyOn(Atomics, "wait");
    expect(() => new MemoryStore(join(tmpDir, "nonbusy.db"))).toThrow(failure);
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps SQLite temporary query data in memory on the store connection", () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("PRAGMA temp_store").get()).toMatchObject({ temp_store: 2 });
  });

  it("keeps facts, pins, events and SQLite sidecars at the selected location only", () => {
    const selected = join(tmpDir, "selected");
    const isolated = new MemoryStore(join(selected, "memory.db"));
    try {
      isolated.setSemantic("pref.editor", "isolated editor");
      isolated.pin("pref.editor");
      expect(isolated.stats()).toEqual({ semantic: 1, events: 1 });
      expect(isolated.listPinned()).toHaveLength(1);
      expect(readdirSync(selected).sort()).toEqual(["memory.db", "memory.db-shm", "memory.db-wal"]);
      expect(readdirSync(tmpDir).sort()).toEqual(["selected", "test.db", "test.db-shm", "test.db-wal"]);
      expect(store.stats()).toEqual({ semantic: 0, events: 0 });
    } finally {
      isolated.close();
    }
  });

  it.each(["PRAGMA journal_mode", "PRAGMA temp_store = MEMORY", "CREATE TABLE", "ALTER TABLE"])("propagates %s failure and closes the connection", (statement) => {
    const path = join(tmpDir, "failure.db");
    createLegacySemantic(path);
    const failure = Object.assign(new Error("deterministic initialization failure"), { code: "ERR_SQLITE_ERROR" });
    const exec = DatabaseSync.prototype.exec;
    const calls = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql.includes(statement)) throw failure;
      return exec.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => new MemoryStore(path)).toThrow(failure);
    expect(calls.mock.calls.some(([sql]) => sql.includes(statement))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].prepare("SELECT 1")).toThrow();
  });

  it("propagates table_info failure and closes the connection", () => {
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      if (sql === "PRAGMA table_info(semantic)") throw new Error("table_info failed");
      return prepare.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => new MemoryStore(join(tmpDir, "pragma.db"))).toThrow("table_info failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].prepare("SELECT 1")).toThrow();
  });

  it("does not attempt ALTER when pinned already exists", () => {
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const current = new MemoryStore(join(tmpDir, "test.db"));
    try {
      expect(exec.mock.calls.some(([sql]) => sql.includes("ALTER TABLE"))).toBe(false);
    } finally {
      current.close();
    }
  });

  it("closes a connection if initialization fails after opening SQLite", () => {
    const path = join(tmpDir, "invalid.db");
    writeFileSync(path, "not a SQLite database");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => new MemoryStore(path)).toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].prepare("SELECT 1")).toThrow();
  });
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
  it("adds pinned to an old semantic table without losing facts", () => {
    const path = join(tmpDir, "old-semantic.db");
    createLegacySemantic(path);
    const migrated = new MemoryStore(path);
    try {
      expect(migrated.getSemantic("pref.editor")).toMatchObject({ value: "legacy editor", pinned: 0 });
      expect(migrated.pin("pref.editor")).toBe(true);
      expect(migrated.listPinned()).toHaveLength(1);
    } finally {
      migrated.close();
    }
  });

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
