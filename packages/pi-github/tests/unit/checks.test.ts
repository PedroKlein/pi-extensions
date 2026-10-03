import { describe, expect, it, vi } from "vitest";
import {
  aggregateChecks,
  waitForChecks,
  type CheckObservation,
} from "../../src/checks.js";

const SHA = "a".repeat(40);

function observation(checks: CheckObservation["checks"]): CheckObservation {
  return { sha: SHA, checks };
}

describe("aggregateChecks", () => {
  it.each([
    [[], "no-checks"],
    [[{ id: 1, name: "build", status: "in_progress", conclusion: null, url: "https://example.test/1" }], "pending"],
    [[{ id: 1, name: "build", status: "completed", conclusion: "success", url: "https://example.test/1" }], "passed"],
    [[{ id: 1, name: "build", status: "completed", conclusion: "failure", url: "https://example.test/1" }], "failed"],
    [[{ id: 1, name: "build", status: "completed", conclusion: "cancelled", url: "https://example.test/1" }], "cancelled"],
  ])("aggregates checks as %s", (checks, expected) => {
    expect(aggregateChecks(observation(checks as CheckObservation["checks"]))).toMatchObject({
      sha: SHA,
      state: expected,
    });
  });

  it("keeps mixed completed and running checks pending", () => {
    expect(aggregateChecks(observation([
      { id: 1, name: "build", status: "completed", conclusion: "failure", url: "https://example.test/1" },
      { id: 2, name: "test", status: "queued", conclusion: null, url: "https://example.test/2" },
    ])).state).toBe("pending");
  });
});

describe("waitForChecks", () => {
  it("allows delayed discovery and emits only transitions", async () => {
    vi.useFakeTimers();
    const observations = [observation([]), observation([]), observation([
      { id: 1, name: "test", status: "queued", conclusion: null, url: "https://example.test/1" },
    ]), observation([
      { id: 1, name: "test", status: "completed", conclusion: "success", url: "https://example.test/1" },
    ])];
    const updates: string[] = [];
    const promise = waitForChecks(async () => observations.shift()!, {
      sha: SHA,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      heartbeatMs: 1_000,
      onUpdate: (snapshot) => updates.push(`${snapshot.state}:${snapshot.completed}/${snapshot.total}`),
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ state: "passed", sha: SHA });
    expect(updates).toEqual(["no-checks:0/0", "pending:0/1", "passed:1/1"]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("does not treat no checks as success without opt-in", async () => {
    vi.useFakeTimers();
    const blocked = waitForChecks(async () => observation([]), {
      sha: SHA,
      timeoutMs: 25,
      pollIntervalMs: 10,
    });
    await vi.runAllTimersAsync();
    await expect(blocked).resolves.toMatchObject({ state: "no-checks", timedOut: true });

    await expect(waitForChecks(async () => observation([]), {
      sha: SHA,
      timeoutMs: 25,
      pollIntervalMs: 10,
      allowNoChecks: true,
    })).resolves.toMatchObject({ state: "passed", noChecksAllowed: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("returns the latest state promptly when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = waitForChecks(async () => observation([
      { id: 1, name: "test", status: "queued", conclusion: null, url: "https://example.test/1" },
    ]), {
      sha: SHA,
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ state: "pending", aborted: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
