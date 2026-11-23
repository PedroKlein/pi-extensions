import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/store.js";

it("bounds real WAL internal waits across IMMEDIATE then EXCLUSIVE contention", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-wal-"));
  const path = join(root, "memory.db");
  const holder = fork(fileURLToPath(new URL("../fixtures/wal-holder.mjs", import.meta.url)), [path], {
    cwd: root, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(holder, "close");
  const phases: string[] = [];
  holder.on("message", (message: { phase: string }) => phases.push(message.phase));
  let db: DatabaseSync | undefined;
  try {
    await once(holder, "message");
    expect(phases).toEqual(["ready"]);
    db = new DatabaseSync(path);
    const attempts: { start: number; duration: number }[] = [];
    const exec = db.exec;
    const start = performance.now();
    vi.spyOn(db, "exec").mockImplementation(function (sql) {
      const before = performance.now();
      try { return exec.call(this, sql); } finally {
        if (sql === "PRAGMA journal_mode = WAL") attempts.push({ start: before - start, duration: performance.now() - before });
      }
    });
    holder.send({ phase: "start", delay: 1_100 });
    // Exercise the actual internal phase on a real connection with a shorter test budget.
    const phase = MemoryStore.prototype as unknown as { enableWal(this: { db: DatabaseSync }, ms: number): void };
    let failure: unknown;
    try { phase.enableWal.call({ db }, 1_500); } catch (error) { failure = error; }
    const elapsed = performance.now() - start;
    expect(failure).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
    expect(attempts.length).toBeGreaterThan(5);
    expect(attempts[0].duration).toBeLessThan(200);
    expect(attempts.at(-1)!.start).toBeGreaterThan(900);
    expect(attempts.at(-1)!.duration).toBeGreaterThan(100);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    // Allows scheduling jitter, but rejects another full wait (and the original ~6s).
    expect(elapsed).toBeLessThan(2_200);
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    console.info("WAL two-stage contention", { elapsedMs: Math.round(elapsed), attempts: attempts.length, last: attempts.at(-1) });
    holder.send({ phase: "stop" });
    await exited;
    expect(phases).toContain("exclusive");
    expect(holder.exitCode).toBe(0);
  } finally {
    vi.restoreAllMocks();
    db?.close();
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
