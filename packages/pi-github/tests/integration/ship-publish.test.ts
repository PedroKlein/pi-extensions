import { describe, expect, it, vi } from "vitest";
import { publishVerified, type ShipPort } from "../../src/ship.js";

const SHA = "a".repeat(40);
const grant = { mode: "autonomous" as const, sessionId: "s", host: "github.com", repository: "org/repo", login: "user", branchMode: "create" as const };

function port(overrides: Partial<ShipPort> = {}): ShipPort {
  return {
    state: vi.fn(async () => ({ currentBranch: "main", defaultBranch: "main", headSha: SHA, clean: true, hasLocalCommits: true, existingPullRequest: false })),
    ancestors: vi.fn(async () => new Set()),
    createBranch: vi.fn(async () => undefined),
    push: vi.fn(async () => ({ remoteSha: SHA })),
    findPullRequest: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({ number: 4, url: "https://example.test/pull/4", headSha: SHA })),
    ...overrides,
  };
}

describe("publishVerified", () => {
  it("publishes verified HEAD to a new ready PR", async () => {
    const subject = port();
    await expect(publishVerified(subject, grant, SHA, { branch: "feature/checks", title: "Checks", body: "Verified" })).resolves.toMatchObject({ branch: "feature/checks", number: 4, headSha: SHA });
    expect(subject.createBranch).toHaveBeenCalledWith("feature/checks", SHA, undefined);
  });

  it.each([
    [{ clean: false }, "clean worktree"],
    [{ hasLocalCommits: false }, "no local commits"],
    [{ headSha: "b".repeat(40) }, "verification"],
  ])("rejects unsafe local state", async (state, message) => {
    const subject = port({ state: vi.fn(async () => ({ currentBranch: "main", defaultBranch: "main", headSha: SHA, clean: true, hasLocalCommits: true, existingPullRequest: false, ...state })) });
    await expect(publishVerified(subject, grant, SHA, { branch: "feature/checks", title: "Checks", body: "Verified" })).rejects.toThrow(message);
  });

  it("refuses divergent remote history", async () => {
    const subject = port({ state: vi.fn(async () => ({ currentBranch: "feature/checks", defaultBranch: "main", headSha: SHA, remoteSha: "b".repeat(40), clean: true, hasLocalCommits: true, existingPullRequest: false })) });
    await expect(publishVerified(subject, { ...grant, branchMode: "adopt" }, SHA, { title: "Checks", body: "Verified" })).rejects.toThrow("non-fast-forward");
  });
});
