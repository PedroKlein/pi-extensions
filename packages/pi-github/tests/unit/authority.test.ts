import { describe, expect, it } from "vitest";
import { createAuthorityStore, replayAuthority, type AuthorityTransition } from "../../src/authority.js";

const grant = {
  mode: "autonomous" as const,
  sessionId: "session-a",
  host: "github.com",
  repository: "org/repo",
  login: "user",
  mergeMethod: "squash" as const,
  allowNoChecks: false,
  blockOptionalFailures: true,
  branchMode: "create" as const,
  deleteRemoteBranch: true,
};

function entries(transitions: AuthorityTransition[]) {
  return transitions.map((data) => ({ type: "custom", customType: "pi-github-authority", data }));
}

describe("GitHub authority", () => {
  it("replays grants and ownership only for the matching session", () => {
    const transitions: AuthorityTransition[] = [
      { version: 1, kind: "grant", at: 1, grant },
      { version: 1, kind: "own", at: 2, sessionId: "session-a", resource: { kind: "pull-request", repository: "org/repo", number: 4, branch: "feature/checks", headSha: "a".repeat(40) } },
    ];

    expect(replayAuthority(entries(transitions), "session-a")).toMatchObject({ grant, ownership: [{ number: 4 }] });
    expect(replayAuthority(entries(transitions), "session-b")).toEqual({ grant: null, ownership: [] });
  });

  it("revokes authority without deleting historical ownership entries", () => {
    const state = replayAuthority(entries([
      { version: 1, kind: "grant", at: 1, grant },
      { version: 1, kind: "revoke", at: 2, sessionId: "session-a" },
    ]), "session-a");
    expect(state.grant).toBeNull();
  });

  it("releases a fully identified owned pull request", () => {
    const resource = { kind: "pull-request" as const, repository: "org/repo", number: 4, branch: "feature/checks", headSha: "a".repeat(40) };
    const store = createAuthorityStore("session-a", () => undefined);
    store.grant(grant);
    store.own(resource);
    store.release({ kind: "pull-request", repository: "org/repo", number: 4, branch: "feature/checks" });

    expect(store.current().ownership).toEqual([]);
  });

  it("appends transitions without tokens or visible marker fields", () => {
    const appended: unknown[] = [];
    const store = createAuthorityStore("session-a", (transition) => appended.push(transition));
    store.grant(grant);
    store.own({ kind: "issue", repository: "org/repo", number: 9 });

    const serialized = JSON.stringify(appended);
    expect(serialized).not.toMatch(/token|marker|ai-generated/i);
    expect(store.current().ownership).toEqual([{ kind: "issue", repository: "org/repo", number: 9 }]);
  });
});
