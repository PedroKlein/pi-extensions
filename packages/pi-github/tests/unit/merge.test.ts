import { describe, expect, it, vi } from "vitest";
import { completeDelivery, type MergePort } from "../../src/merge.js";

const A = "a".repeat(40), B = "b".repeat(40);
const grant = { mode: "autonomous" as const, sessionId: "s", host: "github.com", repository: "org/repo", login: "user", mergeMethod: "squash" as const, allowNoChecks: false, deleteRemoteBranch: true };
const passed = (sha: string) => ({ sha, state: "passed" as const, checks: [], total: 1, completed: 1, pending: [], failed: [], cancelled: [] });
function port(overrides: Partial<MergePort> = {}): MergePort { return { head: vi.fn(async () => ({ sha: A, branch: "feature/x" })), wait: vi.fn(async (sha) => passed(sha)), merge: vi.fn(async () => "merged" as const), enableAutoMerge: vi.fn(async () => true), deleteRemoteBranch: vi.fn(async () => true), ...overrides }; }

describe("completeDelivery", () => {
  it("merges only the exact checked head and deletes only the remote branch", async () => {
    const subject = port();
    await expect(completeDelivery(subject, grant, 4)).resolves.toMatchObject({ state: "merged", headSha: A, branchDeleted: true });
    expect(subject.merge).toHaveBeenCalledWith(4, A, "squash", undefined);
  });
  it("reevaluates an externally changed head", async () => {
    const head = vi.fn().mockResolvedValueOnce({ sha: A, branch: "feature/x" }).mockResolvedValueOnce({ sha: B, branch: "feature/x" }).mockResolvedValue({ sha: B, branch: "feature/x" });
    const subject = port({ head });
    await completeDelivery(subject, grant, 4);
    expect(subject.wait).toHaveBeenNthCalledWith(1, A, false, true, undefined);
    expect(subject.wait).toHaveBeenNthCalledWith(2, B, false, true, undefined);
    expect(subject.merge).toHaveBeenCalledWith(4, B, "squash", undefined);
  });
  it("enables auto-merge when reviews block direct merge", async () => {
    await expect(completeDelivery(port({ merge: vi.fn(async () => "blocked") }), grant, 4)).resolves.toMatchObject({ state: "auto-merge-enabled" });
  });
  it("returns awaiting-review when auto-merge is unavailable", async () => {
    await expect(completeDelivery(port({ merge: vi.fn(async () => "blocked"), enableAutoMerge: vi.fn(async () => false) }), grant, 4)).resolves.toMatchObject({ state: "awaiting-review" });
  });
});
