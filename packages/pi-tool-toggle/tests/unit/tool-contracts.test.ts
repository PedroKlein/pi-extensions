import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piAsk from "../../../pi-ask/src/index.js";
import piFocus from "../../../pi-focus/src/index.js";
import piReadonlyBash from "../../../pi-readonly-bash/src/index.js";
import piRepos from "../../../pi-repos/src/index.js";
import sshSession from "../../../pi-ssh-session/src/index.js";
import piTask from "../../../pi-task/src/index.js";
import piTodo from "../../../pi-todo/src/index.js";

const temporaryDirectories: string[] = [];
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
});

function registeredTools(factory: (pi: ExtensionAPI) => void): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const noop = vi.fn();
  const pi = new Proxy({
    events: { on: noop, emit: noop },
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  }, {
    get(target, property) {
      return property in target ? target[property as keyof typeof target] : noop;
    },
  }) as unknown as ExtensionAPI;

  factory(pi);
  return tools;
}

describe("Pi workflow tool contracts", () => {
  it.each([
    ["ask_user", piAsk],
    ["focus_update", piFocus],
    ["plan_tasks", piTask],
    ["todo", piTodo],
    ["ssh_session", sshSession],
  ] as const)("keeps %s direct to the model but unavailable to nested tools", (name, factory) => {
    const tool = registeredTools(factory).find((candidate) => candidate.name === name);

    expect(tool).toMatchObject({
      exposure: "model-only",
      executionMode: "sequential",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      annotations: {
        readOnlyHint: name === "ask_user",
        destructiveHint: ["plan_tasks", "todo", "ssh_session"].includes(name),
        openWorldHint: ["ask_user", "plan_tasks", "ssh_session"].includes(name),
      },
    });
  });

  it("registers bash_readonly as direct but inactive until an explicit allowlist enables it", () => {
    const tool = registeredTools(piReadonlyBash).find((candidate) => candidate.name === "bash_readonly");

    expect(tool).toMatchObject({
      exposure: "direct",
      defaultActive: false,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    });
  });

  it("uses Pi's native loadout to exclude model-only tools from nested calls", async () => {
    const cwd = process.cwd();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-contracts-"));
    temporaryDirectories.push(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const workflowTools = [
      ...registeredTools(piAsk),
      ...registeredTools(piFocus),
      ...registeredTools(piTask),
      ...registeredTools(piTodo),
      ...registeredTools(sshSession),
    ];
    const customTools = [
      ...workflowTools,
      ...registeredTools(piRepos),
      ...registeredTools(piReadonlyBash),
    ];
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      customTools,
    });

    const active = session.getActiveToolNames();
    const callable = session.getCallableToolNames();
    for (const tool of workflowTools) {
      expect(active).toContain(tool.name);
      expect(callable).not.toContain(tool.name);
    }
    expect(active).not.toContain("repos_list");
    expect(active).not.toContain("bash_readonly");
    expect(callable).toContain("repos_list");
    expect(callable).not.toContain("bash_readonly");

    session.setActiveToolsByName([...session.getActiveToolNames(), "bash_readonly"]);
    expect(session.getCallableToolNames()).toContain("bash_readonly");
    await session.dispose();
  });

  it("serializes a model batch when a stateful tool requires sequential execution", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const cwd = process.cwd();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-execution-"));
    temporaryDirectories.push(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    let active = 0;
    let maxActive = 0;
    const tools = ["first", "second"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} } as never,
      executionMode: "sequential" as const,
      async execute() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { content: [{ type: "text" as const, text: name }], details: {} };
      },
    }));
    const model = {
      id: "fake",
      name: "fake",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    } as never;
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
      customTools: tools,
      model,
    });
    let providerCalls = 0;
    session.agent.streamFunction = (() => {
      providerCalls++;
      const message = {
        role: "assistant",
        content: providerCalls === 1
          ? [
            { type: "toolCall", id: "one", name: "first", arguments: {} },
            { type: "toolCall", id: "two", name: "second", arguments: {} },
          ]
          : [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: providerCalls === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    }) as never;

    await session.agent.prompt("run both");

    expect(providerCalls).toBe(2);
    expect(maxActive).toBe(1);
    await session.dispose();
  });
});
