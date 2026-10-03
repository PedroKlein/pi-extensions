import { describe, expect, it } from "vitest";
import { discoverRepository, parseGitHubRemote, type CommandRunner } from "../../src/repository.js";

function runner(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): CommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    };
  };
}

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:Owner/repository.git", { host: "github.com", owner: "Owner", name: "repository" }],
    ["https://github.com/Owner/repository.git", { host: "github.com", owner: "Owner", name: "repository" }],
    ["ssh://git@git.example.test/Owner/repository.git", { host: "git.example.test", owner: "Owner", name: "repository" }],
    ["https://git.example.test/Owner/repository", { host: "git.example.test", owner: "Owner", name: "repository" }],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });

  it.each([
    "",
    "file:///tmp/repository",
    "https://github.com/owner",
    "git@example.test:owner",
  ])("rejects unsupported remote %s", (remote) => {
    expect(() => parseGitHubRemote(remote)).toThrow("Unsupported GitHub remote");
  });
});

describe("discoverRepository", () => {
  it("resolves repository and exact branch SHAs", async () => {
    const run = runner({
      "git remote get-url origin": { stdout: "git@git.example.test:Owner/repository.git\n" },
      "git symbolic-ref --quiet --short HEAD": { stdout: "feature/work\n" },
      "git rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
      "git rev-parse --verify refs/remotes/origin/feature/work": { stdout: `${"b".repeat(40)}\n` },
      "gh api --hostname git.example.test repos/Owner/repository --jq .default_branch": { stdout: "trunk\n" },
    });

    await expect(discoverRepository(run)).resolves.toEqual({
      host: "git.example.test",
      owner: "Owner",
      name: "repository",
      remote: "origin",
      defaultBranch: "trunk",
      currentBranch: "feature/work",
      headSha: "a".repeat(40),
      remoteTrackingSha: "b".repeat(40),
    });
  });

  it("returns no tracking SHA for a new local branch", async () => {
    const run = runner({
      "git remote get-url origin": { stdout: "https://github.com/owner/repository.git\n" },
      "git symbolic-ref --quiet --short HEAD": { stdout: "feature/new\n" },
      "git rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
      "git rev-parse --verify refs/remotes/origin/feature/new": { stderr: "unknown revision", exitCode: 128 },
      "gh api --hostname github.com repos/owner/repository --jq .default_branch": { stdout: "main\n" },
    });

    await expect(discoverRepository(run)).resolves.toMatchObject({ remoteTrackingSha: undefined });
  });

  it("rejects detached HEAD and missing origin", async () => {
    await expect(discoverRepository(runner({
      "git remote get-url origin": { stderr: "No such remote", exitCode: 2 },
    }))).rejects.toThrow("origin");

    await expect(discoverRepository(runner({
      "git remote get-url origin": { stdout: "https://github.com/owner/repository.git\n" },
      "git symbolic-ref --quiet --short HEAD": { exitCode: 1 },
    }))).rejects.toThrow("detached HEAD");
  });
});
