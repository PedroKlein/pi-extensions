import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const persistence = vi.hoisted(() => ({
  initPlanStorage: vi.fn(async () => "example-project"),
  loadActivePlan: vi.fn(),
}));

vi.mock("../../src/plan-persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/plan-persistence.js")>();
  return {
    ...actual,
    initPlanStorage: persistence.initPlanStorage,
    loadActivePlan: persistence.loadActivePlan,
    loadPlanSummaries: () => [],
  };
});

import piTask from "../../src/index.js";
import {
  createPlanGraph,
  createPlanTask,
  resolveTaskStatuses,
} from "../../src/plan.js";

interface Harness {
  listeners: Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown
  >;
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  ctx: ExtensionContext;
}

function createHarness(branch: unknown[] = []): Harness {
  const listeners = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown
  >();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) =>
        | Promise<unknown>
        | unknown,
    ) => listeners.set(name, handler),
    events: { on: vi.fn(), emit: vi.fn() },
    appendEntry,
    sendMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace/example",
    hasUI: false,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;

  piTask(pi);
  return { listeners, appendEntry, sendMessage, ctx };
}

function makePlan() {
  const task = createPlanTask({
    id: "T1",
    title: "First task",
    description: "Implement the first task",
    order: 1,
  });
  return createPlanGraph({
    name: "example-plan",
    tasks: resolveTaskStatuses([task]),
    scratchDir: "/tmp/example-plan",
  });
}

beforeEach(() => {
  persistence.initPlanStorage.mockClear();
  persistence.loadActivePlan.mockReset();
});

describe("active-plan bootstrap", () => {
  it("injects one compact branch-deduplicated message and never changes the prompt", async () => {
    const plan = makePlan();
    persistence.loadActivePlan.mockResolvedValue(plan);
    const harness = createHarness();

    await harness.listeners.get("session_start")?.(
      { reason: "startup" },
      harness.ctx,
    );

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: "pi-task-plan-bootstrap",
      display: false,
    });
    expect(harness.sendMessage.mock.calls[0]?.[0].content).toContain(
      "[ACTIVE PLAN: example-plan]",
    );
    expect(harness.sendMessage.mock.calls[0]?.[0].content).toContain(
      "Next: T1 — First task",
    );

    const beforeAgentStart = harness.listeners.get("before_agent_start");
    const first = await beforeAgentStart?.(
      { systemPrompt: "stable prefix" },
      harness.ctx,
    );
    plan.tasks[0]!.status = "done";
    const second = await beforeAgentStart?.(
      { systemPrompt: "stable prefix" },
      harness.ctx,
    );
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();

    persistence.loadActivePlan.mockResolvedValue(plan);
    const resumed = createHarness([
      {
        type: "custom",
        customType: "pi-task-plan-bootstrap-marker",
        data: { planName: "example-plan" },
      },
    ]);
    await resumed.listeners.get("session_start")?.(
      { reason: "resume" },
      resumed.ctx,
    );
    expect(resumed.sendMessage).not.toHaveBeenCalled();
  });

  it("does not inject prompt or message state without an active plan", async () => {
    persistence.loadActivePlan.mockResolvedValue(null);
    const harness = createHarness();

    await harness.listeners.get("session_start")?.(
      { reason: "startup" },
      harness.ctx,
    );
    const result = await harness.listeners.get("before_agent_start")?.(
      { systemPrompt: "stable prefix" },
      harness.ctx,
    );

    expect(result).toBeUndefined();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });
});
