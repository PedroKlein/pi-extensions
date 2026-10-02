import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolToggle from "../../src/index.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getSettingsListTheme: () => ({}),
}));

type Handler = (event: unknown, ctx: any) => unknown;
type Command = (args: string, ctx: any) => unknown;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function createAgentDir(settings: object): string {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-toggle-test-"));
  temporaryDirectories.push(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return agentDir;
}

function createHarness(options?: {
  activeTools?: string[];
  branchEntries?: unknown[];
  allTools?: Array<{ name: string; exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden" }>;
}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const allTools = options?.allTools ?? [
    { name: "ssh_session", exposure: "model-only" as const },
    { name: "read", exposure: "direct" as const },
  ];
  let activeTools = options?.activeTools ?? allTools.map((tool) => tool.name);
  let component: { handleInput?(data: string): void } | undefined;

  const appendEntry = vi.fn();
  const setActiveTools = vi.fn((names: string[]) => {
    activeTools = names;
  });
  const pi = {
    appendEntry,
    getActiveTools: () => [...activeTools],
    getAllTools: () => allTools,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: Command }) => commands.set(name, command.handler),
    setActiveTools,
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/workspace/example",
    isProjectTrusted: () => false,
    mode: "tui",
    sessionManager: {
      getBranch: () => options?.branchEntries ?? [],
    },
    ui: {
      custom: async (factory: Function) => {
        component = factory(
          { requestRender: vi.fn() },
          {},
          {},
          vi.fn(),
        );
      },
      notify: vi.fn(),
    },
  };

  toolToggle(pi);

  return {
    appendEntry,
    commands,
    ctx,
    getActiveTools: () => [...activeTools],
    getComponent: () => component,
    handlers,
    setActiveTools,
  };
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("pi-tool-toggle", () => {
  it("disables configured tools in a new session", async () => {
    createAgentDir({
      "pi-tool-toggle": {
        defaultDisabled: ["ssh_session", 42, ""],
      },
    });
    const harness = createHarness();

    await harness.handlers.get("session_start")?.({}, harness.ctx);

    expect(harness.getActiveTools()).toEqual(["read"]);
  });

  it("toggles tools immediately from the TUI and persists the disabled set", async () => {
    createAgentDir({
      "pi-tool-toggle": {
        defaultDisabled: ["ssh_session"],
      },
    });
    const harness = createHarness();
    await harness.handlers.get("session_start")?.({}, harness.ctx);

    await harness.commands.get("tools")?.("", harness.ctx);
    const component = harness.getComponent();
    expect(component).toBeDefined();

    component?.handleInput?.("\r");
    expect(harness.getActiveTools()).toEqual(["read", "ssh_session"]);
    expect(harness.appendEntry).toHaveBeenLastCalledWith("pi-tool-toggle", {
      disabledTools: [],
    });

    component?.handleInput?.("\r");
    expect(harness.getActiveTools()).toEqual(["read"]);
    expect(harness.appendEntry).toHaveBeenLastCalledWith("pi-tool-toggle", {
      disabledTools: ["ssh_session"],
    });
  });

  it("restores branch state instead of applying defaults again", async () => {
    createAgentDir({
      "pi-tool-toggle": {
        defaultDisabled: ["ssh_session"],
      },
    });
    const harness = createHarness({
      branchEntries: [
        {
          type: "custom",
          customType: "pi-tool-toggle",
          data: { disabledTools: ["read"] },
        },
      ],
    });

    await harness.handlers.get("session_start")?.({}, harness.ctx);

    expect(harness.getActiveTools()).toEqual(["ssh_session"]);
  });

  it("reapplies the session mask before an ordinary prompt", async () => {
    createAgentDir({
      "pi-tool-toggle": {
        defaultDisabled: ["ssh_session"],
      },
    });
    const harness = createHarness();
    await harness.handlers.get("session_start")?.({}, harness.ctx);

    harness.setActiveTools(["ssh_session", "read"]);
    await harness.handlers.get("input")?.({}, harness.ctx);

    expect(harness.getActiveTools()).toEqual(["read"]);
  });

  it("does not activate deferred or codemode tools while restoring an unrelated mask", async () => {
    createAgentDir({
      "pi-tool-toggle": {
        defaultDisabled: ["repos_info", "memory_search", "ssh_session"],
      },
    });
    const allTools = [
      { name: "read", exposure: "direct" as const },
      { name: "ssh_session", exposure: "model-only" as const },
      { name: "memory_search", exposure: "codemode" as const },
      { name: "repos_info", exposure: "deferred" as const },
    ];
    const harness = createHarness({ activeTools: ["read", "ssh_session"], allTools });
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    expect(harness.getActiveTools()).toEqual(["read"]);

    harness.ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "pi-tool-toggle",
      data: { disabledTools: [] },
    }];
    await harness.handlers.get("session_tree")?.({}, harness.ctx);

    expect(harness.getActiveTools()).toEqual(["read", "ssh_session"]);
    expect(harness.getActiveTools()).not.toContain("memory_search");
    expect(harness.getActiveTools()).not.toContain("repos_info");
  });

  it("shows registered, declared, callable, and deferred exposure states", async () => {
    createAgentDir({});
    const harness = createHarness({
      activeTools: ["read", "memory_search"],
      allTools: [
        { name: "read", exposure: "direct" },
        { name: "ask_user", exposure: "model-only" },
        { name: "memory_search", exposure: "codemode" },
        { name: "repos_info", exposure: "deferred" },
        { name: "hidden_tool", exposure: "hidden" },
      ],
    });

    await harness.commands.get("tools")?.("", harness.ctx);
    const items = (harness.getComponent() as any)?.items ?? [];
    const state = Object.fromEntries(items.map((item: any) => [item.label, item.currentValue]));

    expect(state).toEqual({
      read: "declared, callable",
      ask_user: "registered",
      memory_search: "declared, callable",
      repos_info: "deferred, callable",
      hidden_tool: "registered",
    });
  });
});
