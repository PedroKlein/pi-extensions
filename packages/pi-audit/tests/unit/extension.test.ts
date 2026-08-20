import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import piAudit from "../../src/index.js";

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

describe("audit-baseline command", () => {
  it("reports categorized burden from command context and shuts down without a model call", async () => {
    let command: RegisteredCommand | undefined;
    const pi = {
      registerCommand: (name: string, options: RegisteredCommand) => {
        if (name === "audit-baseline") command = options;
      },
      on: () => undefined,
      events: { on: () => undefined },
      getActiveTools: () => ["example_tool"],
      getAllTools: () => [
        {
          name: "example_tool",
          description: "Example tool",
          parameters: { type: "object", properties: {} },
          sourceInfo: {
            path: "/packages/example/index.ts",
            source: "example-package",
            scope: "user",
            origin: "package",
          },
        },
      ],
    } as unknown as ExtensionAPI;

    const shutdown = vi.fn();
    const ctx = {
      getSystemPrompt: () => "Stable command-only prompt",
      getSystemPromptOptions: () => ({
        cwd: "/workspace/example",
        skills: [
          {
            name: "example-skill",
            description: "Example guidance",
            filePath: "/home/example/.agents/skills/example-skill/SKILL.md",
            baseDir: "/home/example/.agents/skills/example-skill",
            disableModelInvocation: false,
            sourceInfo: {
              path: "/home/example/.agents/skills/example-skill/SKILL.md",
              source: "user",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      }),
      sessionManager: {
        buildContextEntries: () => [
          {
            type: "custom_message",
            customType: "example-context",
            content: "Model-visible context",
            display: false,
          },
        ],
      },
      shutdown,
    } as unknown as ExtensionCommandContext;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    piAudit(pi);
    expect(command).toBeDefined();
    await command?.handler("", ctx);

    expect(log).toHaveBeenCalledOnce();
    const output = String(log.mock.calls[0]?.[0]);
    expect(output.startsWith("PI_AUDIT_BASELINE=")).toBe(true);
    const report = JSON.parse(output.slice("PI_AUDIT_BASELINE=".length));
    expect(report.categories.systemPrompt.tokens).toBeGreaterThan(0);
    expect(report.categories.skills.personal.count).toBe(1);
    expect(report.categories.activeToolSchemas.count).toBe(1);
    expect(report.categories.modelVisibleCustomMessages.count).toBe(1);
    expect(report.tokenizer).toMatchObject({
      name: "o200k_base",
      accuracy: "estimate",
    });
    expect(report.tokenizer.provenance).toContain("not the active model tokenizer");
    expect(shutdown).toHaveBeenCalledOnce();

    log.mockRestore();
  });
});

describe("audit observability wiring", () => {
  it("records fingerprints and usage through non-model-visible listeners and commands", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const listeners = new Map<
      string,
      (event: unknown, ctx: ExtensionCommandContext) => unknown
    >();
    const busListeners = new Map<string, (data: unknown) => void>();
    const registerTool = vi.fn();
    const pi = {
      registerCommand: (name: string, options: RegisteredCommand) => {
        commands.set(name, options);
      },
      registerTool,
      appendEntry: vi.fn(),
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionCommandContext) => unknown,
      ) => {
        listeners.set(name, handler);
      },
      events: {
        on: (name: string, handler: (data: unknown) => void) => {
          busListeners.set(name, handler);
        },
      },
      getActiveTools: () => ["example_tool"],
      getAllTools: () => [
        {
          name: "example_tool",
          description: "Example tool",
          parameters: { type: "object", properties: {} },
          sourceInfo: {
            path: "/packages/example/index.ts",
            source: "example-package",
            scope: "user",
            origin: "package",
          },
        },
      ],
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const compact = vi.fn();
    const newSession = vi.fn();
    const retainedEntries = [
      {
        type: "message",
        id: "user-1",
        message: { role: "user", content: "retained user text" },
      },
      {
        type: "message",
        id: "tool-1",
        message: {
          role: "toolResult",
          toolName: "example_tool",
          content: [{ type: "text", text: "retained result" }],
        },
      },
    ];
    const ctx = {
      getSystemPrompt: () => "stable prompt",
      getSystemPromptOptions: () => ({ cwd: "/workspace/example", skills: [] }),
      sessionManager: {
        buildContextEntries: () => retainedEntries,
        getBranch: () => retainedEntries,
      },
      getContextUsage: () => ({ tokens: 210_000 }),
      compact,
      newSession,
      ui: { notify },
      shutdown: vi.fn(),
    } as unknown as ExtensionCommandContext;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    piAudit(pi);
    const beforeAgentStart = listeners.get("before_agent_start");
    expect(beforeAgentStart).toBeDefined();
    const hookResult = await beforeAgentStart?.(
      { systemPrompt: "stable prompt" },
      ctx,
    );
    expect(hookResult).toBeUndefined();
    expect(registerTool).not.toHaveBeenCalled();

    busListeners.get("pi-modes:changed")?.({
      mode: "build",
      previousMode: "ask",
    });
    await beforeAgentStart?.({ systemPrompt: "build contract" }, ctx);
    await beforeAgentStart?.(
      { systemPrompt: "build contract\nmutable telemetry" },
      ctx,
    );

    busListeners.get("pi-audit:usage")?.({
      source: "example-extension",
      operation: "background-review",
      model: "custom-provider/example-model",
      input: 10,
      cacheRead: 100,
      cacheWrite: 20,
      output: 30,
      reasoning: 5,
      durationMs: 250,
      trigger: "automatic",
      status: "complete",
    });

    await commands.get("audit-fingerprints")?.handler("", ctx);
    await commands.get("audit-usage")?.handler("", ctx);

    const fingerprintOutput = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("PI_AUDIT_FINGERPRINTS="));
    const usageOutput = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("PI_AUDIT_USAGE="));
    expect(fingerprintOutput).toBeDefined();
    expect(usageOutput).toBeDefined();
    const fingerprintReport = JSON.parse(
      fingerprintOutput!.slice("PI_AUDIT_FINGERPRINTS=".length),
    );
    const usageReport = JSON.parse(
      usageOutput!.slice("PI_AUDIT_USAGE=".length),
    );
    expect(fingerprintReport.current).toMatchObject({
      sequence: 3,
      classification: "unexpected",
      likelySource: "prompt",
      mode: "build",
    });
    expect(fingerprintReport.previous).toMatchObject({
      sequence: 2,
      classification: "expected",
      likelySource: "mode-switch",
      mode: "build",
    });
    expect(usageReport).toMatchObject({
      eventCount: 1,
      totals: {
        input: 10,
        cacheRead: 100,
        cacheWrite: 20,
        output: 30,
        reasoning: 5,
        durationMs: 250,
      },
    });
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Unexplained prompt fingerprint change"),
      "warning",
    );

    await commands.get("context-health")?.handler("", ctx);
    const contextOutput = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("PI_CONTEXT_HEALTH="));
    expect(contextOutput).toBeDefined();
    const contextReport = JSON.parse(
      contextOutput!.slice("PI_CONTEXT_HEALTH=".length),
    );
    expect(contextReport).toMatchObject({
      tokenizer: { accuracy: "estimate" },
      thresholds: {
        currentTokens: 210_000,
        crossed: [100_000, 200_000],
        next: 350_000,
      },
    });
    expect(contextReport.largestToolResults[0]).toMatchObject({
      toolName: "example_tool",
    });
    expect(compact).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();

    await commands.get("audit-ignore-drift")?.handler("", ctx);
    await beforeAgentStart?.(
      { systemPrompt: "build contract\nanother third-party delta" },
      ctx,
    );
    const warnings = notify.mock.calls.filter((call) => call[1] === "warning");
    expect(warnings).toHaveLength(1);

    log.mockRestore();
  });
});

describe("automatic call attribution", () => {
  it("surfaces watchdog lifecycle notices from the shared contract", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const listeners = new Map<string, (event: any, ctx: any) => unknown>();
    const busListeners = new Map<string, (data: unknown) => void>();
    const pi = {
      registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
      registerTool: vi.fn(),
      appendEntry: vi.fn(),
      on: (name: string, handler: (event: any, ctx: any) => unknown) => listeners.set(name, handler),
      events: {
        on: (name: string, handler: (data: unknown) => void) => busListeners.set(name, handler),
      },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const ctx = {
      getSystemPrompt: () => "stable",
      getSystemPromptOptions: () => ({ cwd: "/workspace/example" }),
      getContextUsage: () => ({ tokens: 0 }),
      sessionManager: { getBranch: () => [] },
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    piAudit(pi);
    await listeners.get("session_start")?.({ reason: "new" }, ctx);
    for (const status of ["start", "complete", "error"] as const) {
      busListeners.get("pi-audit:usage")?.({
        source: "pi-subagents-watchdog",
        operation: `watchdog-review-${status}`,
        model: "custom-provider/reviewer",
        input: status === "complete" ? 12 : 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: status === "complete" ? 4 : 0,
        reasoning: 0,
        durationMs: status === "start" ? 0 : 25,
        trigger: "automatic",
        status,
      });
    }

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("watchdog-review started"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("watchdog-review completed"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("watchdog-review failed"),
      "error",
    );
  });

  it("attributes a core retry and reports its completed usage", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const listeners = new Map<string, (event: any, ctx: any) => unknown>();
    const busListeners = new Map<string, (data: unknown) => void>();
    const pi = {
      registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
      registerTool: vi.fn(),
      appendEntry: vi.fn(),
      on: (name: string, handler: (event: any, ctx: any) => unknown) => listeners.set(name, handler),
      events: {
        on: (name: string, handler: (data: unknown) => void) => busListeners.set(name, handler),
      },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const ctx = {
      model: { provider: "custom-provider", id: "example-model" },
      getSystemPrompt: () => "stable",
      getSystemPromptOptions: () => ({ cwd: "/workspace/example" }),
      getContextUsage: () => ({ tokens: 0 }),
      sessionManager: { getBranch: () => [] },
      ui: { notify },
    } as unknown as ExtensionCommandContext;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    piAudit(pi);
    await listeners.get("session_start")?.({ reason: "new" }, ctx);
    await listeners.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "temporary provider failure",
          },
        ],
      },
      ctx,
    );
    await listeners.get("agent_start")?.({}, ctx);
    await listeners.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: {
              input: 11,
              cacheRead: 22,
              cacheWrite: 3,
              output: 4,
              reasoning: 5,
            },
          },
        ],
      },
      ctx,
    );
    await listeners.get("agent_settled")?.({}, ctx);
    await commands.get("audit-usage")?.handler("", ctx);

    const output = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("PI_AUDIT_USAGE="));
    const report = JSON.parse(output!.slice("PI_AUDIT_USAGE=".length));
    expect(report.events).toEqual([
      expect.objectContaining({
        source: "pi-core",
        operation: "retry-start",
        status: "start",
        retryLayer: "core",
        attempt: 1,
        route: "custom-provider/example-model",
      }),
      expect.objectContaining({
        source: "pi-core",
        operation: "retry-complete",
        status: "complete",
        retryLayer: "core",
        attempt: 1,
        input: 11,
        cacheRead: 22,
        cacheWrite: 3,
        output: 4,
        reasoning: 5,
      }),
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("core retry 1 started"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("core retry 1 completed"),
      "info",
    );

    log.mockRestore();
  });
});

describe("context lifecycle notices", () => {
  it("warns once per threshold segment, resets on lifecycle changes, and remains read-only", async () => {
    const listeners = new Map<
      string,
      (event: unknown, ctx: ExtensionCommandContext) => unknown
    >();
    const registerTool = vi.fn();
    const pi = {
      registerCommand: vi.fn(),
      registerTool,
      appendEntry: vi.fn(),
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionCommandContext) => unknown,
      ) => listeners.set(name, handler),
      events: { on: vi.fn() },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    let contextTokens = 360_000;
    const notify = vi.fn();
    const compact = vi.fn();
    const newSession = vi.fn();
    const ctx = {
      getContextUsage: () => ({ tokens: contextTokens }),
      getSystemPrompt: () => "stable",
      getSystemPromptOptions: () => ({ cwd: "/workspace/example" }),
      sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
      ui: { notify },
      compact,
      newSession,
    } as unknown as ExtensionCommandContext;

    piAudit(pi);
    const turnEnd = listeners.get("turn_end");
    await turnEnd?.({}, ctx);
    await turnEnd?.({}, ctx);
    expect(
      notify.mock.calls.filter((call) =>
        String(call[0]).startsWith("Context crossed"),
      ),
    ).toHaveLength(3);

    await listeners.get("session_compact")?.({}, ctx);
    await turnEnd?.({}, ctx);
    await listeners.get("session_tree")?.({}, ctx);
    await turnEnd?.({}, ctx);
    await listeners.get("session_start")?.({ reason: "new" }, ctx);
    await turnEnd?.({}, ctx);
    expect(
      notify.mock.calls.filter((call) =>
        String(call[0]).startsWith("Context crossed"),
      ),
    ).toHaveLength(12);

    const toolResult = listeners.get("tool_result");
    contextTokens = 99_999;
    await toolResult?.(
      { toolName: "plan_tasks", input: { action: "complete" }, isError: false },
      ctx,
    );
    contextTokens = 100_000;
    await toolResult?.(
      { toolName: "plan_tasks", input: { action: "complete" }, isError: false },
      ctx,
    );
    expect(
      notify.mock.calls.filter((call) =>
        String(call[0]).startsWith("Task completed with"),
      ),
    ).toHaveLength(1);

    const promptResult = await listeners.get("before_agent_start")?.(
      { systemPrompt: "stable" },
      ctx,
    );
    expect(promptResult).toBeUndefined();
    expect(registerTool).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });
});
