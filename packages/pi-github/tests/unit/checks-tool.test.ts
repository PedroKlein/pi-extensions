import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerGitHubChecks } from "../../src/checks-tool.js";
import type { CheckSource } from "../../src/checks.js";

const SHA = "a".repeat(40);

function register(source: CheckSource, options?: { pollIntervalMs?: number; heartbeatMs?: number }) {
  const tools: any[] = [];
  const pi = { registerTool: (tool: any) => tools.push(tool) } as unknown as ExtensionAPI;
  registerGitHubChecks(pi, source, options);
  return tools[0];
}

const ctx = { cwd: "/repo" } as ExtensionContext;

describe("github_checks tool", () => {
  it("registers a directly exposed read-only tool", () => {
    const tool = register({ observe: vi.fn() });

    expect(tool).toMatchObject({
      name: "github_checks",
      exposure: "direct",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
    expect(tool.promptGuidelines.join(" ")).toContain("Do not use Bash sleep");
  });

  it("returns bounded SHA-bound status", async () => {
    const source: CheckSource = {
      observe: vi.fn(async () => ({
        sha: SHA,
        checks: Array.from({ length: 30 }, (_, index) => ({
          id: index + 1,
          name: `check-${index}`,
          status: "completed",
          conclusion: index === 0 ? "failure" : "success",
          url: `https://example.test/${index}`,
        })),
      })),
    };
    const result = await register(source).execute("call", {
      action: "status",
      sha: SHA,
      timeoutMs: 1,
      allowNoChecks: false,
    }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({ sha: SHA, state: "failed", total: 30 });
    expect(result.content[0].text.length).toBeLessThan(8_000);
    expect(result.details.checks).toHaveLength(20);
    expect(result.details.omittedChecks).toBe(10);
  });

  it("publishes replaceable wait snapshots without logs", async () => {
    const source: CheckSource = {
      observe: vi.fn()
        .mockResolvedValueOnce({ sha: SHA, checks: [{ id: 1, name: "test", status: "queued", conclusion: null, url: "https://example.test/1" }] })
        .mockResolvedValue({ sha: SHA, checks: [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "https://example.test/1" }] }),
    };
    const updates: any[] = [];
    const result = await registerGitHubChecksResult(source, updates);

    expect(result.details).toMatchObject({ sha: SHA, state: "passed" });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((update) => !JSON.stringify(update).includes("logs"))).toBe(true);
  });
});

async function registerGitHubChecksResult(source: CheckSource, updates: any[]) {
  const tool = register(source, { pollIntervalMs: 1 });
  return tool.execute("call", {
    action: "wait",
    sha: SHA,
    timeoutMs: 1_000,
    allowNoChecks: false,
  }, undefined, (update: any) => updates.push(update), ctx);
}
