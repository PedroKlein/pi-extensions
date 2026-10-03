import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDiagnosis } from "../../src/diagnosis.js";

const SHA = "a".repeat(40);
const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("formatDiagnosis", () => {
  it.each(["failure", "startup_failure", "cancelled"])("preserves %s evidence and attempt identity", async (conclusion) => {
    const result = await formatDiagnosis({
      runId: 42,
      attempt: 3,
      sha: SHA,
      conclusion,
      url: "https://example.test/run/42",
      jobs: [{ name: "test", conclusion, steps: [{ name: "run tests", conclusion }] }],
      annotations: [{ path: "src/index.ts", message: "failed", level: "failure", startLine: 7 }],
      logs: "test failed",
    });

    expect(result).toMatchObject({ runId: 42, attempt: 3, sha: SHA, conclusion });
    expect(result.jobs[0].steps[0]).toEqual({ name: "run tests", conclusion });
    expect(result.annotations[0].path).toBe("src/index.ts");
  });

  it("handles unavailable logs", async () => {
    const result = await formatDiagnosis({
      runId: 1, attempt: 1, sha: SHA, conclusion: "failure", url: "https://example.test/1",
      jobs: [], annotations: [], logs: null,
    });
    expect(result.logsUnavailable).toBe(true);
    expect(result.logExcerpt).toBeUndefined();
  });

  it("redacts and privately persists oversized logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-github-diagnosis-test-"));
    directories.push(directory);
    const secret = "super-secret-token";
    const result = await formatDiagnosis({
      runId: 2, attempt: 1, sha: SHA, conclusion: "failure", url: "https://example.test/2",
      jobs: [], annotations: [], logs: `Authorization: Bearer ${secret}\nGITHUB_TOKEN=${secret}\n${"x".repeat(20_000)}`,
    }, { persistDirectory: directory, secrets: [secret], maxLogBytes: 1_000 });

    expect(result.logExcerpt).not.toContain(secret);
    expect(result.fullLogPath).toBeDefined();
    expect((await stat(result.fullLogPath!)).mode & 0o777).toBe(0o600);
    expect(await readFile(result.fullLogPath!, "utf8")).not.toContain(secret);
  });
});
