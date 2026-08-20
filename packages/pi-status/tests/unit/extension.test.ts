import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createFingerprintStore } from "../../../pi-audit/src/fingerprints.js";
import piStatus from "../../src/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

describe("pi-status extension", () => {
  it("keeps changing context telemetry in UI without changing the system prompt", async () => {
    const listeners = new Map<string, EventHandler[]>();
    const pi = {
      on: (name: string, handler: EventHandler) => {
        const handlers = listeners.get(name) ?? [];
        handlers.push(handler);
        listeners.set(name, handlers);
      },
      events: { on: vi.fn() },
      exec: async (command: string, args: string[]) => {
        if (command === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "main\n", stderr: "", killed: false };
        }
        if (command === "git" && args[0] === "worktree") {
          return {
            code: 0,
            stdout: "worktree /workspace/example\n\nworktree /workspace/other\n",
            stderr: "",
            killed: false,
          };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      },
      getThinkingLevel: () => "max",
    } as unknown as ExtensionAPI;

    let contextTokens = 100_000;
    const widgets: string[][] = [];
    const ctx = {
      cwd: "/workspace/example",
      model: {
        provider: "custom-provider",
        id: "example-model",
        name: "Example Model",
        contextWindow: 200_000,
      },
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: contextTokens }),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget: (_id: string, lines: string[]) => widgets.push(lines),
        setTitle: vi.fn(),
        setFooter: vi.fn(),
      },
    } as unknown as ExtensionContext;

    piStatus(pi);
    for (const handler of listeners.get("session_start") ?? []) {
      await handler({}, ctx);
    }

    const applyPromptHooks = async (base: string): Promise<string> => {
      let prompt = base;
      for (const handler of listeners.get("before_agent_start") ?? []) {
        const result = (await handler(
          { systemPrompt: prompt },
          ctx,
        )) as { systemPrompt?: string } | undefined;
        prompt = result?.systemPrompt ?? prompt;
      }
      return prompt;
    };

    const fingerprints = createFingerprintStore();
    const firstPrompt = await applyPromptHooks("stable base prompt");
    fingerprints.record({ systemPrompt: firstPrompt, tools: [], activeToolNames: [] });

    contextTokens = 150_000;
    for (const handler of listeners.get("turn_end") ?? []) {
      await handler({}, ctx);
    }
    const secondPrompt = await applyPromptHooks("stable base prompt");
    const second = fingerprints.record({
      systemPrompt: secondPrompt,
      tools: [],
      activeToolNames: [],
    });

    expect(listeners.has("before_agent_start")).toBe(false);
    expect(second.promptChanged).toBe(false);
    expect(secondPrompt).toBe(firstPrompt);
    const rendered = widgets.at(-1)?.join("\n") ?? "";
    expect(rendered).toContain("75% 150k/200k");
    expect(rendered).toContain("main");
    expect(rendered).toContain("2 worktrees active");
  });
});
