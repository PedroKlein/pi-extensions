import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piFocus from "../../src/index.js";
import { FOCUS_ENTRY_TYPE, createFocusTransition } from "../../src/state.js";

type Tool = {
  name: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
};
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function harness(branch: unknown[] = []) {
  let activeBranch = branch;
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const listeners = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const notifications: string[] = [];
  let widget: any;
  let editorResult: string | undefined;
  let confirmed = false;
  const abortController = new AbortController();

  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    signal: abortController.signal,
    sessionManager: { getBranch: () => activeBranch },
    ui: {
      notify: (message: string) => notifications.push(message),
      editor: vi.fn(async () => editorResult),
      confirm: vi.fn(async () => confirmed),
      setWidget: vi.fn((_id: string, value: any) => { widget = value; }),
    },
  } as unknown as ExtensionContext;

  piFocus(pi);
  return {
    tools,
    commands,
    entries,
    notifications,
    ctx,
    setEditorResult: (value: string | undefined) => { editorResult = value; },
    setConfirmed: (value: boolean) => { confirmed = value; },
    setBranch: (value: unknown[]) => { activeBranch = value; },
    abort: () => abortController.abort(),
    widgetLines: (width = 120) => {
      if (!widget) return [];
      if (Array.isArray(widget)) return widget;
      return widget({ requestRender: vi.fn() }, {}).render(width);
    },
    emit: async (name: string, event: any = {}) => {
      const results = [];
      for (const handler of listeners.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    start: async (reason = "startup") => {
      for (const handler of listeners.get("session_start") ?? []) await handler({ reason }, ctx);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("focus_update", () => {
  it("persists explicit updates and normalizes flexible durations", async () => {
    const h = harness();
    await h.start();
    const tool = h.tools.get("focus_update")!;

    const first = await tool.execute("call-1", {
      goal: "Ship focus",
      now: "Implementing tool",
      then: "Render widget",
      state: "active",
      expected_duration: "2d",
    }, undefined, undefined, h.ctx);
    await tool.execute("call-2", { now: "Tool complete", state: "done" }, undefined, undefined, h.ctx);

    expect(h.entries).toHaveLength(2);
    expect(h.entries[0].type).toBe(FOCUS_ENTRY_TYPE);
    expect((h.entries[0].data as any).snapshot.expectedDurationMs).toBe(172_800_000);
    expect((h.entries[1].data as any).snapshot).toMatchObject({
      goal: "Ship focus",
      now: "Tool complete",
      then: "Render widget",
      state: "done",
    });
    expect(first.content[0].text).toContain("2–7d");
  });

  it("rejects missing first goal and invalid durations without appending", async () => {
    const h = harness();
    await h.start();
    const tool = h.tools.get("focus_update")!;

    await expect(tool.execute("call", { now: "Working" }, undefined, undefined, h.ctx)).rejects.toThrow("goal");
    await expect(tool.execute("call", { goal: "Goal", expected_duration: "forever" }, undefined, undefined, h.ctx)).rejects.toThrow("duration");
    expect(h.entries).toHaveLength(0);
  });

  it("has explicit activation and transition guidance without clear authority", () => {
    const tool = harness().tools.get("focus_update")!;
    const guidance = tool.promptGuidelines?.join(" ") ?? "";

    for (const phrase of [
      "substantive work",
      "explicitly requests",
      "ask for clarification",
      "establishing a goal",
      "detouring",
      "expected-long work",
      "waiting or blocked",
      "returning",
      "completing or handing off",
    ]) expect(guidance).toContain(phrase);
    expect(guidance).not.toMatch(/infer|chain-of-thought|clear focus/i);
    expect(JSON.stringify(tool.parameters)).not.toContain('"clear"');
  });
});

describe("/focus", () => {
  let persisted: unknown[];

  beforeEach(() => {
    const transition = createFocusTransition(null, {
      goal: "Ship focus",
      now: "State model",
      then: "Tool",
    }, "agent", 100);
    persisted = [{ type: "custom", customType: FOCUS_ENTRY_TYPE, data: transition }];
  });

  it("shows current focus and recent history", async () => {
    const h = harness(persisted);
    await h.start();
    await h.commands.get("focus")!.handler("", h.ctx);

    expect(h.notifications.at(-1)).toContain("Goal: Ship focus");
    expect(h.notifications.at(-1)).toContain("Now: State model");
    expect(h.notifications.at(-1)).toContain("Recent:");
  });

  it("edits focus through the native editor", async () => {
    const h = harness(persisted);
    h.setEditorResult("Goal: Ship focus\nNow: Editing controls\nThen: Widget\nState: active\nExpected: 3h\nHandoff:");
    await h.start();
    await h.commands.get("focus")!.handler("edit", h.ctx);

    expect(h.entries).toHaveLength(1);
    expect((h.entries[0].data as any).source).toBe("user");
    expect((h.entries[0].data as any).snapshot).toMatchObject({
      now: "Editing controls",
      then: "Widget",
      expectedDurationMs: 10_800_000,
    });
  });

  it("clears only after confirmation", async () => {
    const cancelled = harness(persisted);
    await cancelled.start();
    await cancelled.commands.get("focus")!.handler("clear", cancelled.ctx);
    expect(cancelled.entries).toHaveLength(0);

    const confirmed = harness(persisted);
    confirmed.setConfirmed(true);
    await confirmed.start();
    await confirmed.commands.get("focus")!.handler("clear", confirmed.ctx);
    expect((confirmed.entries[0].data as any).kind).toBe("clear");
  });

  it("reports empty focus", async () => {
    const h = harness();
    await h.start();
    await h.commands.get("focus")!.handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("No focus");
  });

  it("reconstructs focus when the active session tree branch changes", async () => {
    const h = harness(persisted);
    await h.start();
    const right = createFocusTransition(null, { goal: "Other branch", now: "Right" }, "agent", 200);
    h.setBranch([{ type: "custom", customType: FOCUS_ENTRY_TYPE, data: right }]);
    await h.emit("session_tree");
    expect(h.widgetLines().join("\n")).toContain("▌ FOCUS  Other branch");
    expect(h.widgetLines().join("\n")).toContain("Right");
  });

  it("renders settled focus below the editor and switches to active during a turn", async () => {
    const h = harness(persisted);
    await h.start();
    expect(h.widgetLines()[1]).toContain("▌ LAST");

    await h.emit("agent_start");
    expect(h.widgetLines()[1]).toContain("▌ NOW");
    await h.emit("agent_settled");
    expect(h.widgetLines()[1]).toContain("▌ LAST");
  });

  it("shows safe aggregate telemetry for parallel tools", async () => {
    const h = harness(persisted);
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", {
      toolCallId: "one",
      toolName: "subagent",
      args: { task: "secret child prompt" },
    });
    await h.emit("tool_execution_start", {
      toolCallId: "two",
      toolName: "subagent",
      args: { task: "another secret" },
    });

    const rendered = h.widgetLines().join("\n");
    expect(rendered).toContain("▌ RUN    subagents (2)");
    expect(rendered).not.toContain("secret");

    await h.emit("tool_execution_end", { toolCallId: "two", toolName: "subagent", isError: true });
    expect(h.widgetLines().join("\n")).toContain("▌ RUN    subagent");
    await h.emit("tool_execution_end", { toolCallId: "one", toolName: "subagent", isError: false });
    expect(h.widgetLines()).toHaveLength(3);
  });

  it("persists long and exceptional telemetry and warns once for a possible stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const long = createFocusTransition(null, {
      goal: "Run checks",
      now: "integration tests",
      expectedDurationMs: 60_000,
    }, "agent", 0);
    const h = harness([{ type: "custom", customType: FOCUS_ENTRY_TYPE, data: long }]);
    await h.start();
    await h.emit("tool_execution_start", { toolCallId: "long", toolName: "bash", args: { command: "secret" } });
    expect(h.entries.map((entry) => entry.type)).toEqual(["pi-focus-telemetry"]);

    await vi.advanceTimersByTimeAsync(150_000);
    expect(h.notifications.filter((message) => message.includes("possibly stalled"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.notifications.filter((message) => message.includes("possibly stalled"))).toHaveLength(1);
    await h.emit("tool_execution_end", { toolCallId: "long", toolName: "bash", isError: false });
    expect(h.entries.map((entry) => (entry.data as any).kind)).toEqual([
      "execution-start", "stall", "execution-end",
    ]);

    await h.emit("tool_execution_start", { toolCallId: "routine", toolName: "read", args: { path: "secret" } });
    await h.emit("tool_execution_end", { toolCallId: "routine", toolName: "read", isError: true });
    expect((h.entries.at(-1)?.data as any).kind).toBe("failure");
    expect(JSON.stringify(h.entries)).not.toContain("secret");
  });

  it("records waiting and aborted execution without raw arguments", async () => {
    const h = harness();
    await h.start();
    await h.tools.get("focus_update")!.execute("focus", {
      goal: "Wait for approval", now: "user response", state: "waiting",
    }, undefined, undefined, h.ctx);
    expect(h.entries.map((entry) => (entry.data as any).kind)).toEqual(["update", "waiting"]);

    await h.emit("tool_execution_start", {
      toolCallId: "cancelled", toolName: "bash", args: { command: "token=secret" },
    });
    h.abort();
    await h.emit("tool_execution_end", { toolCallId: "cancelled", toolName: "bash", isError: true });
    expect((h.entries.at(-1)?.data as any).kind).toBe("abort");
    expect(JSON.stringify(h.entries)).not.toContain("token=secret");
  });

  it("disposes monitoring on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const long = createFocusTransition(null, {
      goal: "Run checks", now: "tests", expectedDurationMs: 60_000,
    }, "agent", 0);
    const h = harness([{ type: "custom", customType: FOCUS_ENTRY_TYPE, data: long }]);
    await h.start();
    await h.emit("tool_execution_start", { toolCallId: "long", toolName: "bash", args: {} });
    await h.emit("session_shutdown");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.notifications.some((message) => message.includes("possibly stalled"))).toBe(false);
  });

  it("shows one resume card only for unfinished resumed focus", async () => {
    const h = harness(persisted);
    await h.start("resume");
    await h.start("resume");
    expect(h.notifications.filter((message) => message.startsWith("Resume ·"))).toHaveLength(1);

    const done = createFocusTransition(null, { goal: "Done", state: "done" }, "agent", 100);
    const completed = harness([{ type: "custom", customType: FOCUS_ENTRY_TYPE, data: done }]);
    await completed.start("resume");
    expect(completed.notifications.some((message) => message.startsWith("Resume ·"))).toBe(false);
  });

  it("marks stale focus and injects one hidden refresh reminder per epoch", async () => {
    const h = harness(persisted);
    await h.start();
    await h.emit("turn_end");
    await h.emit("turn_end");
    expect(h.widgetLines().join("\n")).not.toContain("possibly stale");
    await h.emit("turn_end");
    expect(h.widgetLines().join("\n")).toContain("possibly stale");

    const first = (await h.emit("before_agent_start", { systemPrompt: "stable" }))[0] as any;
    const second = (await h.emit("before_agent_start", { systemPrompt: "stable" }))[0];
    expect(first.message).toMatchObject({ customType: "pi-focus-reminder", display: false });
    expect(first.systemPrompt).toBeUndefined();
    expect(second).toBeUndefined();

    const context = (await h.emit("context", { messages: [
      { role: "custom", customType: "pi-focus-reminder", content: "old" },
      { role: "user", content: "keep" },
    ] }))[0] as any;
    expect(context.messages).toEqual([{ role: "user", content: "keep" }]);

    await h.tools.get("focus_update")!.execute("refresh", { now: "Still editing controls" }, undefined, undefined, h.ctx);
    expect(h.widgetLines().join("\n")).not.toContain("possibly stale");
    await h.emit("turn_end"); await h.emit("turn_end"); await h.emit("turn_end");
    const again = (await h.emit("before_agent_start", { systemPrompt: "stable" }))[0] as any;
    expect(again.message.customType).toBe("pi-focus-reminder");
  });

  it("includes unmatched long execution evidence in the resume card", async () => {
    const focus = createFocusTransition(null, { goal: "Ship", now: "tests" }, "agent", 100);
    const start = {
      version: 1, kind: "execution-start", id: "old", toolName: "bash",
      label: "integration tests", expectedDurationMs: 2 * 86_400_000, at: 200,
    };
    const h = harness([
      { type: "custom", customType: FOCUS_ENTRY_TYPE, data: focus },
      { type: "custom", customType: "pi-focus-telemetry", data: start },
    ]);
    await h.start("resume");
    expect(h.notifications.at(-1)).toContain("Interrupted · integration tests · expected 2–7d");
  });
});
