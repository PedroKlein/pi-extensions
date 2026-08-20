import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piModes from "../../src/index.js";
import type { Mode } from "../../src/types.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void> | void;

function createHarness(mode: Mode) {
  const listeners = new Map<string, EventHandler>();
  const busListeners = new Map<string, (data: { mode: string }) => void>();
  const commands = new Map<string, CommandHandler>();
  const setActiveTools = vi.fn();
  const select = vi.fn();
  const emit = vi.fn();
  const sendUserMessage = vi.fn();
  const pi = {
    on: (name: string, handler: EventHandler) => listeners.set(name, handler),
    events: {
      on: (name: string, handler: (data: { mode: string }) => void) =>
        busListeners.set(name, handler),
      emit,
    },
    registerShortcut: vi.fn(),
    registerCommand: (
      name: string,
      options: { handler: CommandHandler },
    ) => commands.set(name, options.handler),
    getAllTools: () => [
      { name: "read" },
      { name: "write" },
      { name: "bash" },
      { name: "bash_readonly" },
    ],
    setActiveTools,
    appendEntry: vi.fn(),
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace/example",
    hasUI: true,
    model: { provider: "custom-provider", id: "example-model" },
    abort: vi.fn(),
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "pi-mode",
          data: { mode },
        },
      ],
    },
    getSystemPromptOptions: () => ({
      skills: [
        {
          name: "grill-me",
          filePath: `${homedir()}/.agents/skills/grill-me/SKILL.md`,
        },
        {
          name: "tdd",
          filePath: `${homedir()}/.agents/skills/tdd/SKILL.md`,
        },
        {
          name: "skill-judge",
          filePath: `${homedir()}/.agents/skills/skill-judge/SKILL.md`,
          disableModelInvocation: true,
        },
        {
          name: "pi-subagents",
          filePath: "/Users/example/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md",
        },
      ],
    }),
    ui: {
      notify: vi.fn(),
      select,
    },
  } as unknown as ExtensionContext;

  piModes(pi);
  return {
    listeners,
    busListeners,
    commands,
    emit,
    sendUserMessage,
    setActiveTools,
    select,
    ctx,
  };
}

async function start(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.listeners.get("session_start")?.({}, harness.ctx);
}

async function prompt(
  harness: ReturnType<typeof createHarness>,
  systemPrompt = "stable base prompt",
): Promise<{ systemPrompt?: string } | undefined> {
  return (await harness.listeners.get("before_agent_start")?.(
    { systemPrompt },
    harness.ctx,
  )) as { systemPrompt?: string } | undefined;
}

describe("exact-name personal skill resolver", () => {
  it("rewrites an explicit exact-name request through native skill expansion", async () => {
    const harness = createHarness("ask");
    await start(harness);

    const result = await harness.listeners.get("input")?.(
      {
        text: "Please use the grill-me skill to challenge this plan",
        source: "interactive",
      },
      harness.ctx,
    );

    expect(result).toEqual({
      action: "transform",
      text: "/skill:grill-me Please use the grill-me skill to challenge this plan",
    });
  });

  it("resolves an explicit-only personal skill by exact name", async () => {
    const harness = createHarness("ask");
    await start(harness);
    const text = "Use the skill-judge skill to audit this SKILL.md";

    const result = await harness.listeners.get("input")?.(
      { text, source: "interactive" },
      harness.ctx,
    );

    expect(result).toEqual({
      action: "transform",
      text: `/skill:skill-judge ${text}`,
    });
  });

  it.each(["use", "load", "apply", "run", "invoke"])(
    "supports the explicit %s verb",
    async (verb) => {
      const harness = createHarness("ask");
      await start(harness);
      const text = `Please ${verb} the grill-me skill for this plan`;

      const result = await harness.listeners.get("input")?.(
        { text, source: "interactive" },
        harness.ctx,
      );

      expect(result).toEqual({
        action: "transform",
        text: `/skill:grill-me ${text}`,
      });
    },
  );

  it.each([
    "Do not use the grill-me skill for this plan",
    "Don't load grill-me for this plan",
    "Never apply the grill-me skill",
    "Continue without using the grill-me skill",
    "I cannot use the grill-me skill here",
  ])("does not resolve a negated request: %s", async (text) => {
    const harness = createHarness("ask");
    await start(harness);

    const result = await harness.listeners.get("input")?.(
      { text, source: "interactive" },
      harness.ctx,
    );

    expect(result).toBeUndefined();
  });

  it.each([
    ["The grill-me skill is useful", "interactive"],
    ["Use the unknown-skill skill", "interactive"],
    ["Use the pi-subagents skill", "interactive"],
    ["Use the grill-mega skill", "interactive"],
    ["Use the grill-me skill", "extension"],
    ["Compare grill-me and tdd", "interactive"],
  ])("ignores non-invocations: %s", async (text, source) => {
    const harness = createHarness("ask");
    await start(harness);

    const result = await harness.listeners.get("input")?.(
      { text, source },
      harness.ctx,
    );

    expect(result).toBeUndefined();
  });

  it("handles multiple named personal skills without loading either", async () => {
    const harness = createHarness("ask");
    await start(harness);

    const result = await harness.listeners.get("input")?.(
      {
        text: "Use the grill-me and tdd skills for this plan",
        source: "interactive",
      },
      harness.ctx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Name one personal skill per request so Pi can expand it deterministically.",
      "warning",
    );
  });
});

describe("mode contracts", () => {
  it("loads an active contract from the package-relative prompts directory", async () => {
    const harness = createHarness("ask");
    await start(harness);

    const result = await prompt(harness);

    expect(result?.systemPrompt).toContain("[MODE: ASK]");
    expect(result?.systemPrompt).not.toBe("stable base prompt");
  });

  it("keeps build entry stable and dialog-free across turns", async () => {
    const harness = createHarness("build");
    await start(harness);

    const first = await prompt(harness);
    const second = await prompt(harness);

    expect(first?.systemPrompt).toContain("[MODE: BUILD]");
    expect(second?.systemPrompt).toBe(first?.systemPrompt);
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("keeps none mode raw with every tool active and no prompt injection", async () => {
    const harness = createHarness("none");
    await start(harness);

    const result = await prompt(harness);

    expect(result).toBeUndefined();
    expect(harness.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "write",
      "bash",
      "bash_readonly",
    ]);
  });

  it("switches mode commands without starting a model turn", async () => {
    const harness = createHarness("ask");
    await start(harness);

    await harness.commands.get("build")?.(
      "",
      harness.ctx as unknown as ExtensionCommandContext,
    );

    expect(harness.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "write",
      "bash",
    ]);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    expect((await prompt(harness))?.systemPrompt).toContain("[MODE: BUILD]");
  });

  it("does not publish mode contracts as prompt templates", () => {
    const packagePath = fileURLToPath(
      new URL("../../package.json", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      pi?: { prompts?: string[] };
    };

    expect(manifest.pi?.prompts).toBeUndefined();
  });

  it("attributes the in-run mode-switch continuation exactly once", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness("ask");
      await start(harness);

      harness.busListeners.get("pi-ask:mode-switch")?.({ mode: "build" });
      expect(harness.ctx.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(151);
      expect(harness.sendUserMessage).toHaveBeenCalledOnce();

      await harness.listeners.get("agent_end")?.(
        {
          messages: [
            {
              role: "assistant",
              usage: {
                input: 2,
                cacheRead: 100,
                cacheWrite: 10,
                output: 20,
                reasoning: 5,
              },
            },
          ],
        },
        harness.ctx,
      );

      const usageEvents = harness.emit.mock.calls.filter(
        (call) => call[0] === "pi-audit:usage",
      );
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.[1]).toMatchObject({
        source: "pi-modes",
        operation: "mode-switch-continuation",
        model: "custom-provider/example-model",
        input: 2,
        cacheRead: 100,
        cacheWrite: 10,
        output: 20,
        reasoning: 5,
        trigger: "automatic",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["ask", "brainstorm", "plan", "build"] as const)(
    "%s contract contains only purpose, boundaries, and completion guidance",
    (mode) => {
      const path = fileURLToPath(
        new URL(`../../prompts/${mode}.md`, import.meta.url),
      );
      const content = readFileSync(path, "utf8");

      expect(content).toContain("Purpose:");
      expect(content).toContain("Boundaries:");
      expect(content).toContain("Completion:");
      expect(content).not.toMatch(
        /ask_user|plan_tasks|subagent|verify_work|proof-of-work|planning skill/i,
      );
    },
  );
});
