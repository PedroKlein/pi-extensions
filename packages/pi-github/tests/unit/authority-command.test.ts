import { describe, expect, it } from "vitest";
import { grantFromSelections } from "../../src/authority-command.js";

const identity = { sessionId: "session-a", host: "github.com", repository: "org/repo", login: "user" };

describe("github autonomy command choices", () => {
  it("defaults autonomous safety policy", () => {
    expect(grantFromSelections(identity, { mode: "autonomous" })).toEqual({
      ...identity,
      mode: "autonomous",
      mergeMethod: "squash",
      allowNoChecks: false,
      blockOptionalFailures: true,
      branchMode: "create",
      deleteRemoteBranch: true,
    });
  });

  it("supports read-only and collaboration grants without delivery choices", () => {
    expect(grantFromSelections(identity, { mode: "read-only" })).toMatchObject({ mode: "read-only" });
    expect(grantFromSelections(identity, { mode: "collaboration" })).toMatchObject({ mode: "collaboration" });
  });
});
