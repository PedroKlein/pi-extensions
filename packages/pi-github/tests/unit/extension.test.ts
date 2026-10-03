import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import githubExtension from "../../src/index.js";

interface Harness {
  pi: ExtensionAPI;
  tools: Map<string, any>;
  commands: string[];
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => Promise<void>>>;
  active: string[];
}

function harness(): Harness {
  const tools = new Map<string, any>();
  const commands: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => Promise<void>>>();
  const state = { active: ["github_checks"] };
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.push(name),
    appendEntry() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<void>) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => { state.active = [...names]; },
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    commands,
    handlers,
    get active() { return state.active; },
  };
}

describe("pi-github extension", () => {
  it("loads and registers its tools and command", () => {
    const subject = harness();

    expect(() => githubExtension(subject.pi)).not.toThrow();
    expect([...subject.tools.keys()]).toEqual(["github_checks", "github_pr", "github_issue", "github_ship"]);
    expect(subject.tools.get("github_ship").exposure).toBe("hidden");
    expect(subject.commands).toEqual(["github-autonomy"]);
  });

  it("restores autonomous ship exposure from the matching session branch", async () => {
    const subject = harness();
    githubExtension(subject.pi);
    const sessionId = "session-a";
    const ctx = {
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [{
          type: "custom",
          customType: "pi-github-authority",
          data: {
            version: 1,
            kind: "grant",
            at: 1,
            grant: {
              mode: "autonomous",
              sessionId,
              host: "github.com",
              repository: "org/repo",
              login: "user",
              mergeMethod: "squash",
              allowNoChecks: false,
              blockOptionalFailures: true,
              branchMode: "create",
              deleteRemoteBranch: true,
            },
          },
        }],
      },
    } as unknown as ExtensionContext;

    for (const handler of subject.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, ctx);
    }

    expect(subject.tools.get("github_ship").exposure).toBe("model-only");
    expect(subject.active).toContain("github_ship");
  });
});
