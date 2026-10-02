import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAsk from "../../src/index.js";

describe("pi-ask prompt placement", () => {
  it("keeps ask_user guidance on the tool and registers no prompt hook", () => {
    const tools: Array<{
      name: string;
      description?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
    }> = [];
    const events: string[] = [];
    const pi = {
      registerTool: (tool: {
        name: string;
        description?: string;
        promptGuidelines?: string[];
        parameters?: unknown;
      }) => tools.push(tool),
      registerCommand: vi.fn(),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI;

    piAsk(pi);

    const askUser = tools.find((tool) => tool.name === "ask_user");
    expect(askUser?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ALWAYS use ask_user"),
      ]),
    );
    expect(events).not.toContain("before_agent_start");
    expect(JSON.stringify(askUser)).not.toContain("action");
  });

  it("attributes option explanations dispatched through ModelRuntime", async () => {
    let askUser: any;
    let component: { handleInput(data: string): void } | undefined;
    let finish: ((value: unknown) => void) | undefined;
    const response: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Use this option when latency matters." }],
      api: "test-api",
      provider: "backend-a",
      model: "physical-model",
      usage: {
        input: 11,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 1,
        totalTokens: 19,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const emit = vi.fn();
    const pi = {
      registerTool: (tool: unknown) => { askUser = tool; },
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { emit },
    } as unknown as ExtensionAPI;
    piAsk(pi);

    const selectedModel = { provider: "router", id: "auto" };
    const execution = askUser.execute(
      "call-1",
      {
        questions: [{
          id: "q1",
          prompt: "Which option?",
          type: "single",
          options: [{ value: "fast", label: "Fast" }],
        }],
      },
      undefined,
      undefined,
      {
        hasUI: true,
        model: selectedModel,
        modelRegistry: {
          streamSimple,
          getApiKeyAndHeaders: vi.fn(() => {
            throw new Error("credential lookup must stay inside ModelRuntime");
          }),
        },
        ui: {
          custom: (factory: any) => new Promise((resolve) => {
            finish = resolve;
            component = factory(
              { requestRender: vi.fn() },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text },
              {},
              resolve,
            );
          }),
        },
      },
    );

    await vi.waitFor(() => expect(component).toBeDefined());
    component!.handleInput("?");
    for (const char of "Why?") component!.handleInput(char);
    component!.handleInput("\r");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    finish!({ questions: [], answers: [], cancelled: true });
    await execution;

    expect(streamSimple).toHaveBeenCalledWith(
      selectedModel,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-ask",
        operation: "option-explain",
        model: "router/auto",
        route: "backend-a/physical-model",
        input: 11,
        output: 5,
      }),
    );
  });
});
