import { describe, expect, it } from "vitest";
import { executeMutation } from "../../src/operations.js";

const success = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, aborted: false, outcome: "success" as const, truncation: { stdoutOmittedBytes: 0, stderrOmittedBytes: 0 } };

describe("mutation reconciliation", () => {
  it("parses confirmed success", async () => {
    await expect(executeMutation(async () => success, async () => null, (result) => result.stdout)).resolves.toBe("ok");
  });

  it("reconciles an ambiguous outcome without retrying", async () => {
    const unknown = { ...success, exitCode: null, timedOut: true, outcome: "outcome-unknown" as const };
    await expect(executeMutation(async () => unknown, async () => ({ number: 4 }), () => ({ number: 5 }))).resolves.toEqual({ number: 4 });
  });
});
