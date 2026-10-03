import { describe, expect, it } from "vitest";
import { authorizeMutation, blockedGitHubMutation } from "../../src/policy.js";

const grant = { mode: "autonomous" as const, sessionId: "s1", host: "github.com", repository: "org/repo", login: "user" };

describe("GitHub mutation policy", () => {
  it.each([
    "git push origin feature/x",
    "git push --force-with-lease",
    "gh pr create --title change",
    "gh issue close 4",
    "gh pr merge 9 --squash",
    "gh api -X POST repos/org/repo/issues",
  ])("blocks model-issued remote mutation: %s", (command) => {
    expect(blockedGitHubMutation(command)).toContain("typed GitHub tools");
  });

  it.each([
    "git status --short",
    "git log -1",
    "gh pr view 4",
    "gh issue list",
    "gh api repos/org/repo",
  ])("allows read-only inspection: %s", (command) => {
    expect(blockedGitHubMutation(command)).toBeNull();
  });

  it("rejects missing, cross-session, cross-repository, default-branch, force, and unowned writes", () => {
    expect(() => authorizeMutation({ grant: null, sessionId: "s1", host: "github.com", repository: "org/repo" })).toThrow("authority");
    expect(() => authorizeMutation({ grant, sessionId: "s2", host: "github.com", repository: "org/repo" })).toThrow("session");
    expect(() => authorizeMutation({ grant, sessionId: "s1", host: "github.com", repository: "other/repo" })).toThrow("repository");
    expect(() => authorizeMutation({ grant, sessionId: "s1", host: "github.com", repository: "org/repo", branch: "main", defaultBranch: "main" })).toThrow("default branch");
    expect(() => authorizeMutation({ grant, sessionId: "s1", host: "github.com", repository: "org/repo", force: true })).toThrow("Force");
    expect(() => authorizeMutation({ grant, sessionId: "s1", host: "github.com", repository: "org/repo", requiresOwnership: true, owned: false })).toThrow("owned");
  });

  it("allows repository-scoped owned writes", () => {
    expect(() => authorizeMutation({ grant, sessionId: "s1", host: "github.com", repository: "org/repo", requiresOwnership: true, owned: true })).not.toThrow();
  });
});
