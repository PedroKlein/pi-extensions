import { describe, expect, it, vi } from "vitest";
import { waitForChecks } from "../../src/checks.js";
import { formatDiagnosis } from "../../src/diagnosis.js";
import { completeDelivery, type MergePort } from "../../src/merge.js";
import { publishVerified, type ShipPort } from "../../src/ship.js";

const A = "a".repeat(40), B = "b".repeat(40);
const grant = { mode: "autonomous" as const, sessionId: "session", host: "github.com", repository: "org/repo", login: "user", mergeMethod: "squash" as const, allowNoChecks: false, blockOptionalFailures: true, branchMode: "create" as const, deleteRemoteBranch: true };

describe("CI delivery regression", () => {
  it("replaces shell sleep polling with one streaming wait and exact-head repair flow", async () => {
    vi.useFakeTimers();
    const shellCommands: string[] = [];
    const updates: string[] = [];
    const observations = [
      { sha: A, checks: [] },
      { sha: A, checks: [{ id: 1, name: "test", status: "queued", conclusion: null, url: "https://example.test/check/1" }] },
      { sha: A, checks: [{ id: 1, name: "test", status: "completed", conclusion: "failure", url: "https://example.test/check/1" }] },
    ];
    const wait = waitForChecks(async () => observations.shift()!, { sha: A, timeoutMs: 1_000, pollIntervalMs: 10, onUpdate: (state) => updates.push(state.state) });
    await vi.runAllTimersAsync();
    await expect(wait).resolves.toMatchObject({ state: "failed", sha: A });
    expect(updates).toEqual(["no-checks", "pending", "failed"]);
    expect(shellCommands).not.toContain(expect.stringMatching(/sleep/));

    const diagnosis = await formatDiagnosis({ runId: 7, attempt: 1, sha: A, conclusion: "failure", url: "https://example.test/run/7", jobs: [{ name: "test", conclusion: "failure", steps: [{ name: "unit", conclusion: "failure" }] }], annotations: [], logs: "assertion failed" });
    expect(diagnosis.logExcerpt).toBe("assertion failed");

    const ship: ShipPort = {
      state: vi.fn(async () => ({ currentBranch: "feature/checks", defaultBranch: "main", headSha: B, clean: true, hasLocalCommits: true, existingPullRequest: false })),
      ancestors: vi.fn(async () => new Set()), createBranch: vi.fn(),
      push: vi.fn(async () => ({ remoteSha: B })),
      findPullRequest: vi.fn(async () => ({ number: 4, url: "https://example.test/pull/4", headSha: B })),
      createPullRequest: vi.fn(),
    };
    await expect(publishVerified(ship, { ...grant, branchMode: "adopt" }, B, { title: "Fix checks", body: "Verified" })).resolves.toMatchObject({ number: 4, headSha: B });

    const merge: MergePort = {
      head: vi.fn(async () => ({ sha: B, branch: "feature/checks" })),
      wait: vi.fn(async () => ({ sha: B, state: "passed", checks: [], total: 1, completed: 1, pending: [], failed: [], cancelled: [] })),
      merge: vi.fn(async (_number, sha) => sha === B ? "merged" : "unknown"),
      enableAutoMerge: vi.fn(async () => false), deleteRemoteBranch: vi.fn(async () => true),
    };
    await expect(completeDelivery(merge, grant, 4)).resolves.toMatchObject({ state: "merged", headSha: B });
    expect(merge.merge).toHaveBeenCalledWith(4, B, "squash", undefined);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
