import { describe, expect, it } from "vitest";
import { requireFastForward, selectPublishBranch } from "../../src/branch.js";

const base = { currentBranch: "feature/work", defaultBranch: "main", headSha: "a".repeat(40), clean: true, hasLocalCommits: true, existingPullRequest: false };

describe("publish branch selection", () => {
  it("creates a branch from default without changing current branch", () => {
    expect(selectPublishBranch({ ...base, currentBranch: "main" }, { branchMode: "create", requestedBranch: "feature/work" })).toEqual({ branch: "feature/work", create: true });
  });
  it("adopts only non-default branches without PRs", () => {
    expect(selectPublishBranch(base, { branchMode: "adopt" })).toEqual({ branch: "feature/work", create: false });
    expect(() => selectPublishBranch({ ...base, existingPullRequest: true }, { branchMode: "adopt" })).toThrow("existing pull request");
  });
  it("accepts only fast-forward remote ancestry", () => {
    expect(() => requireFastForward("b".repeat(40), new Set())).toThrow("non-fast-forward");
    expect(() => requireFastForward("b".repeat(40), new Set(["b".repeat(40)]))).not.toThrow();
  });
});
