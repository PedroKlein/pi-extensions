import { describe, expect, it } from "vitest";
import {
  GitHubAdapter,
  type ProcessExecution,
  type ProcessExecutor,
} from "../../src/adapter.js";

class FakeExecutor implements ProcessExecutor {
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

  constructor(private readonly execute: (command: string, args: string[]) => ProcessExecution) {}

  async run(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<ProcessExecution> {
    this.calls.push({ command, args, env: options.env });
    return this.execute(command, args);
  }
}

describe("GitHubAdapter", () => {
  it("selects the host account without inherited token shadowing", async () => {
    const executor = new FakeExecutor((command, args) => {
      expect(command).toBe("gh");
      expect(args).toEqual(["auth", "status", "--hostname", "git.example.test", "--json", "hosts"]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hosts: {
            "git.example.test": [
              { login: "second", active: false, state: "success" },
              { login: "preferred", active: true, state: "success" },
            ],
          },
        }),
        stderr: "",
        timedOut: false,
        aborted: false,
      };
    });
    const adapter = new GitHubAdapter(executor, {
      GITHUB_TOKEN: "invalid-inherited-token",
      GH_TOKEN: "also-invalid",
      PATH: process.env.PATH,
    });

    await expect(adapter.resolveIdentity("git.example.test")).resolves.toEqual({
      host: "git.example.test",
      login: "preferred",
      tokenShadowingIgnored: true,
    });
    expect(executor.calls[0].env.GITHUB_TOKEN).toBeUndefined();
    expect(executor.calls[0].env.GH_TOKEN).toBeUndefined();
    expect(executor.calls[0].env.GH_HOST).toBe("git.example.test");
  });

  it("bounds and redacts command output", async () => {
    const secret = "secret-value";
    const executor = new FakeExecutor(() => ({
      exitCode: 0,
      stdout: `${secret}:${"x".repeat(100)}`,
      stderr: `Authorization: Bearer ${secret}`,
      timedOut: false,
      aborted: false,
    }));
    const adapter = new GitHubAdapter(executor, { GITHUB_TOKEN: secret }, { maxOutputBytes: 32 });

    const result = await adapter.runGh("github.com", ["api", "user"]);

    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32);
    expect(result.truncation.stdoutOmittedBytes).toBeGreaterThan(0);
    expect(executor.calls[0].env.GH_HOST).toBe("github.com");
  });

  it("classifies timed-out mutations as outcome unknown", async () => {
    const executor = new FakeExecutor(() => ({
      exitCode: null,
      stdout: "",
      stderr: "timed out",
      timedOut: true,
      aborted: false,
    }));
    const adapter = new GitHubAdapter(executor);

    await expect(adapter.runGh("github.com", ["pr", "create"], { mutation: true })).resolves.toMatchObject({
      outcome: "outcome-unknown",
    });
    await expect(adapter.runGh("github.com", ["api", "user"])).resolves.toMatchObject({
      outcome: "failure",
    });
  });

  it("classifies confirmed nonzero mutation responses as failures", async () => {
    const adapter = new GitHubAdapter(new FakeExecutor(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "validation failed",
      timedOut: false,
      aborted: false,
    })));

    await expect(adapter.runGh("github.com", ["issue", "create"], { mutation: true })).resolves.toMatchObject({
      outcome: "failure",
      exitCode: 1,
    });
  });
});
