import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store.js";
import { createLegacyDb, legacyEvent, legacyFact, legacyTables } from "../fixtures/legacy-db.js";

const WORKERS = 4;
const WRITES = 12;
const workerPath = fileURLToPath(new URL("../fixtures/concurrency-worker.mjs", import.meta.url));
type Message = { phase: string; storage?: { agentDir: string; dbPath: string; mode: string }; pid?: number; error?: string };

function spawnWorker(cwd: string) {
  const child = fork(workerPath, [], {
    cwd,
    // Node 24 and 26 both support native erasable TypeScript; no SDK/loader dependency.
    execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  let output = "";
  let terminalError: Error | undefined;
  let wake: (() => void) | undefined;
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { output += data; });
  child.on("message", (message) => { messages.push(message as Message); wake?.(); });
  child.on("error", (error) => { terminalError = error; wake?.(); });
  const exited = new Promise<void>((resolve) => {
    child.on("close", (code, signal) => {
      terminalError ??= new Error(`Worker closed: ${code}/${signal}\n${output}`);
      wake?.();
      resolve();
    });
  });
  return {
    child,
    exited,
    async wait(phase: string): Promise<Message> {
      const deadline = Date.now() + 15_000;
      while (true) {
        const message = messages.shift();
        if (message) {
          if (message.phase !== phase) throw new Error(`Expected ${phase}: ${JSON.stringify(message)}\n${output}`);
          return message;
        }
        if (terminalError) throw terminalError;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { wake = undefined; reject(new Error(`Worker timeout: ${phase}\n${output}`)); }, Math.max(0, deadline - Date.now()));
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    },
    send(message: object) {
      return new Promise<void>((resolve, reject) => child.send(message, (error) => error ? reject(error) : resolve()));
    },
  };
}

async function waitForExit(worker: ReturnType<typeof spawnWorker>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker exit timeout")), 5_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stopWorkers(workers: ReturnType<typeof spawnWorker>[]) {
  for (const { child } of workers) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(workers.map((worker) => worker.exited));
}

function inspect(path: string, operation: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try { operation(db); } finally { db.close(); }
}

describe("real multi-process SQLite contention", () => {
  it.each(["cold", "existing", "migration", "two-agents", "parent-alias"])("preserves every write/event under %s contention", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-processes-"));
    const workers: ReturnType<typeof spawnWorker>[] = [];
    const groupCount = scenario === "two-agents" ? 2 : 1;
    const home = join(root, "fake-home");
    const config = join(root, "actual-config");
    const alias = join(root, "config-alias");
    if (scenario === "parent-alias") {
      mkdirSync(home);
      mkdirSync(config);
      symlinkSync(config, join(home, ".pi"));
      symlinkSync(config, alias);
    }
    const agentFor = (n: number) => scenario === "parent-alias"
      ? join([config, alias, join(home, ".pi")][n % 3], "agent")
      : join(root, `agent-${Math.floor(n / WORKERS)}`);
    const paths = Array.from({ length: groupCount }, (_, group) => scenario === "parent-alias"
      ? join(home, ".pi", "memory", "memory.db") : join(root, `agent-${group}`, "memory", "memory.db"));
    let legacySnapshot: ReturnType<typeof legacyTables> | undefined;
    try {
      if (scenario === "existing") {
        const db = new MemoryStore(paths[0]);
        db.setSemantic("pref.existing", "retained");
        db.close();
      } else if (scenario === "migration") {
        createLegacyDb(paths[0], false);
        inspect(paths[0], (db) => { legacySnapshot = legacyTables(db); });
      }
      // Every worker has a different real cwd; four independently opened connections per agent.
      for (let n = 0; n < WORKERS * groupCount; n++) {
        const cwd = join(root, `cwd-${n}`);
        mkdirSync(cwd);
        workers.push(spawnWorker(cwd));
      }
      await Promise.all(workers.map((worker) => worker.wait("ready")));
      await Promise.all(workers.map((worker, n) => worker.send({
        phase: "write", id: n, writes: WRITES, createAgent: scenario === "parent-alias",
        options: { agentDir: agentFor(n), homeDir: home, configDirName: ".pi", isProjectTrusted: true },
      })));
      const written = await Promise.all(workers.map((worker) => worker.wait("written")));
      expect(new Set(written.map((message) => message.pid)).size).toBe(WORKERS * groupCount);
      for (let group = 0; group < groupCount; group++) {
        for (const message of written.slice(group * WORKERS, (group + 1) * WORKERS)) {
          expect(message.storage).toEqual({ agentDir: agentFor(written.indexOf(message)), dbPath: paths[group], mode: scenario === "parent-alias" ? "legacy-global" : "agent-local" });
        }
        const baseEvents = ["cold", "two-agents", "parent-alias"].includes(scenario) ? 0 : 1;
        const baseFacts = baseEvents;
        const store = new MemoryStore(paths[group]);
        try {
          expect(store.stats()).toEqual({ semantic: baseFacts + WORKERS * WRITES + 1, events: baseEvents + WORKERS * WRITES * 2 });
          for (let n = 0; n < WORKERS * groupCount; n++) {
            for (let k = 0; k < WRITES; k++) {
              const fact = store.getSemantic(`test.worker-${n}.${k}`);
              if (Math.floor(n / WORKERS) === group) expect(fact?.value).toBe(`worker ${n} value ${k}`);
              else expect(fact).toBeUndefined();
            }
          }
          expect(store.getSemantic("test.shared")?.value).toMatch(/^worker \d+ update 11$/);
          if (scenario === "migration") {
            expect(store.getSemantic(legacyFact.key)).toEqual({ ...legacyFact, pinned: 0 });
            expect(store.listEvents(1000)).toContainEqual(legacyEvent);
          }
        } finally { store.close(); }
        inspect(paths[group], (db) => {
          expect(db.prepare("SELECT event_type, COUNT(*) AS count FROM events WHERE memory_key = 'test.shared' GROUP BY event_type ORDER BY event_type").all())
            .toEqual([{ event_type: "create", count: 1 }, { event_type: "update", count: WORKERS * WRITES - 1 }]);
          const ownEvents = db.prepare("SELECT memory_key, COUNT(*) AS count FROM events WHERE memory_key LIKE 'test.worker-%' GROUP BY memory_key").all();
          expect(ownEvents).toHaveLength(WORKERS * WRITES);
          expect(ownEvents.every((event) => event.count === 1)).toBe(true);
        });
      }
      // No deletes before all writes and their exact event counts have been checked.
      await Promise.all(workers.map((worker, n) => worker.send({ phase: "delete", id: n, writes: WRITES })));
      await Promise.all(workers.map((worker) => worker.wait("deleted")));
      await Promise.all(workers.map(waitForExit));
      for (const { child } of workers) expect(child.exitCode).toBe(0);
      for (const path of paths) {
        const baseEvents = ["cold", "two-agents", "parent-alias"].includes(scenario) ? 0 : 1;
        const store = new MemoryStore(path);
        try {
          expect(store.deleteSemantic("test.shared")).toBe(true);
          expect(store.stats()).toEqual({ semantic: baseEvents, events: baseEvents + WORKERS * WRITES * 3 + 1 });
        } finally { store.close(); }
        inspect(path, (db) => {
          expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect(db.prepare("SELECT COUNT(*) AS count FROM semantic WHERE key LIKE 'test.%'").get()).toEqual({ count: 0 });
          if (legacySnapshot) expect(legacyTables(db)).toEqual(legacySnapshot);
        });
      }
    } finally {
      await stopWorkers(workers);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
