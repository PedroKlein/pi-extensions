import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStorage, type DbPathResolverOptions } from "../../src/db-path-resolver.js";
import { MemoryStore } from "../../src/store.js";
import { createLegacyDb, legacyEvent, legacyFact, legacyTables } from "../fixtures/legacy-db.js";

let root: string;
let home: string;
let cwd: string;
let stores: MemoryStore[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-memory-compat-"));
  home = join(root, "fake-home");
  cwd = join(root, "cwd-a");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(root, "cwd-b"));
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});
function options(agentDir: string, overrides: Partial<DbPathResolverOptions> = {}): DbPathResolverOptions {
  return { agentDir, homeDir: home, cwd, configDirName: ".pi", isProjectTrusted: true, ...overrides };
}
function open(opts: DbPathResolverOptions) {
  const storage = resolveStorage(opts);
  const store = new MemoryStore(storage.dbPath);
  stores.push(store);
  return { storage, store };
}

describe("real storage compatibility and overrides", () => {
  it.each([true, false])("opens Hermes' fake-home legacy database (pinned column: %s) in place", (pinned) => {
    const agentDir = join(home, ".pi", "agent");
    const dbPath = join(home, ".pi", "memory", "memory.db");
    mkdirSync(agentDir, { recursive: true });
    createLegacyDb(dbPath, pinned);
    const original = new DatabaseSync(dbPath);
    let snapshot;
    try { snapshot = legacyTables(original); } finally { original.close(); }

    const { store, storage } = open(options(join(agentDir, "..", "agent")));
    expect(storage).toEqual({ agentDir, dbPath, mode: "legacy-global" });
    expect(store.stats()).toEqual({ semantic: 1, events: 1 });
    expect(store.getSemantic(legacyFact.key)).toEqual({ ...legacyFact, pinned: pinned ? 1 : 0 });
    expect(store.listPinned()).toEqual(pinned ? [{ ...legacyFact, pinned: 1 }] : []);
    expect(store.listEvents()).toEqual([legacyEvent]);
    expect(existsSync(join(agentDir, "memory"))).toBe(false);
    expect(readdirSync(agentDir)).toEqual([]);
    const inspected = new DatabaseSync(dbPath);
    try {
      expect(legacyTables(inspected)).toEqual(snapshot);
      expect(inspected.prepare("PRAGMA table_info(semantic)").all().filter((column) => column.name === "pinned")).toHaveLength(1);
      expect(inspected.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { inspected.close(); }
  });

  it("shares an agent's real default across cwd A/B, including delete from B, but isolates another agent", () => {
    const agentDir = join(home, "pico", "agent");
    const a = open(options(agentDir));
    const b = open(options(agentDir, { cwd: join(root, "cwd-b") }));
    const other = open(options(join(home, "eros", "agent")));
    expect(a.storage).toEqual(b.storage);
    expect(a.storage.mode).toBe("agent-local");
    a.store.setSemantic("pref.shared", "current agent");
    a.store.pin("pref.shared");
    expect(b.store.listPinned()).toMatchObject([{ key: "pref.shared", value: "current agent" }]);
    expect(other.store.getSemantic("pref.shared")).toBeUndefined();
    other.store.setSemantic("pref.shared", "other agent");
    expect(b.store.deleteSemantic("pref.shared")).toBe(true);
    expect(a.store.getSemantic("pref.shared")).toBeUndefined();
    expect(other.store.getSemantic("pref.shared")?.value).toBe("other agent");
  });

  it.each(["standard", "custom"])("uses trusted absolute/relative overrides ahead of %s defaults and really separates the stores", (kind) => {
    const agentDir = kind === "standard" ? join(home, ".pi", "agent") : join(home, "pico", "agent");
    const opts = options(agentDir);
    const defaultStore = open({ ...opts, cwd: join(root, "cwd-b") });
    defaultStore.store.setSemantic("pref.location", "default");
    for (const directory of [join(root, "absolute-override"), "./relative-override"]) {
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-memory": { localPath: directory } }));
      const selected = open(opts);
      expect(selected.storage).toEqual({ agentDir, dbPath: join(resolve(cwd, directory), "memory.db"), mode: "project-local" });
      expect(selected.store.getSemantic("pref.location")).toBeUndefined();
      selected.store.setSemantic("pref.location", directory);
      const untrusted = open({ ...opts, isProjectTrusted: false });
      expect(untrusted.storage).toEqual(defaultStore.storage);
      expect(untrusted.store.getSemantic("pref.location")?.value).toBe("default");
      expect(defaultStore.store.getSemantic("pref.location")?.value).toBe("default");
      expect(selected.store.deleteSemantic("pref.location")).toBe(true);
      expect(defaultStore.store.getSemantic("pref.location")?.value).toBe("default");
    }
    // Even a malformed project configuration is not interpreted when untrusted.
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ invalid untrusted config");
    expect(open({ ...opts, isProjectTrusted: false }).storage).toEqual(defaultStore.storage);
  });

  it.each(["standard", "custom"])("reports an explicit override equal to the %s default as project-local", (kind) => {
    const agentDir = kind === "standard" ? join(home, ".pi", "agent") : join(home, "pico", "agent");
    const opts = options(agentDir);
    const fallback = resolveStorage(opts);
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-memory": { localPath: dirname(fallback.dbPath) } }));
    expect(resolveStorage(opts)).toEqual({ ...fallback, mode: "project-local" });
  });
});
