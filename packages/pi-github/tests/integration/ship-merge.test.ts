import { describe, expect, it, vi } from "vitest";
import { completeDelivery, type MergePort } from "../../src/merge.js";

const SHA = "a".repeat(40);
const grant = { mode: "autonomous" as const, sessionId: "s", host: "github.com", repository: "org/repo", login: "user", allowNoChecks: false };

describe("ship merge policy", () => {
  it.each(["failed", "cancelled", "no-checks"] as const)("does not merge %s checks", async (state) => {
    const merge = vi.fn();
    const port: MergePort = {
      head: vi.fn(async () => ({ sha: SHA, branch: "feature/x" })),
      wait: vi.fn(async () => ({ sha: SHA, state, checks: [], total: 0, completed: 0, pending: [], failed: [], cancelled: [] })),
      merge,
      enableAutoMerge: vi.fn(),
      deleteRemoteBranch: vi.fn(),
    };
    await expect(completeDelivery(port, grant, 4)).resolves.toMatchObject({ state: "checks-failed" });
    expect(merge).not.toHaveBeenCalled();
  });
});
