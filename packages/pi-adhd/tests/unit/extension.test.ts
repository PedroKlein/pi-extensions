import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatTUIOptions } from "../../src/chat/tui.js";

const host = vi.hoisted(() => ({
  createChatTUI: vi.fn(),
}));

vi.mock("../../src/chat/tui.js", () => ({
  createChatTUI: host.createChatTUI,
}));

import piAdhd from "../../src/index.js";

function response(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Answer" }],
    api: "test-api",
    provider: "backend-a",
    model: "physical-model",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 1,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("pi-adhd nested model usage", () => {
  beforeEach(() => {
    host.createChatTUI.mockReset();
  });

  it("summarizes main context through ModelRuntime before opening a template chat", async () => {
    const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
    const emit = vi.fn();
    const pi = {
      on: vi.fn(),
      registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
      registerShortcut: vi.fn(),
      registerMessageRenderer: vi.fn(),
      events: { emit },
    } as unknown as ExtensionAPI;
    const selectedModel = { provider: "router", id: "auto" };
    const final = response();
    const streamSimple = vi.fn().mockReturnValue({ result: vi.fn().mockResolvedValue(final) });
    const getApiKeyAndHeaders = vi.fn(() => {
      throw new Error("credential lookup must stay inside ModelRuntime");
    });
    const ctx = {
      hasUI: true,
      model: selectedModel,
      signal: undefined,
      modelRegistry: { streamSimple, getApiKeyAndHeaders },
      sessionManager: {
        getEntries: () => [{
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Investigate the failure" }] },
        }],
      },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    piAdhd(pi);
    await commands.get("btw")!.handler("compact", ctx as ExtensionCommandContext);

    expect(streamSimple).toHaveBeenCalledWith(
      selectedModel,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      {},
    );
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(host.createChatTUI).toHaveBeenCalledWith(
      expect.objectContaining({ ctx, extraContext: "Answer" }),
      expect.any(Object),
    );
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({ operation: "main-context-summary", route: "backend-a/physical-model" }),
    );
  });

  it("attributes side-chat responses to the selected model and physical route", async () => {
    const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
    const emit = vi.fn();
    const pi = {
      on: vi.fn(),
      registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
      registerShortcut: vi.fn(),
      registerMessageRenderer: vi.fn(),
      events: { emit },
    } as unknown as ExtensionAPI;
    const selectedModel = { provider: "router", id: "auto" };
    const ctx = {
      hasUI: true,
      model: selectedModel,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    const final = response();
    host.createChatTUI.mockImplementation(async (options: ChatTUIOptions) => {
      options.onResponse(final, 25, selectedModel);
    });

    piAdhd(pi);
    await commands.get("btw")!.handler("", ctx as ExtensionCommandContext);

    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-adhd",
        operation: "side-chat",
        model: "router/auto",
        route: "backend-a/physical-model",
        input: 10,
        output: 4,
        durationMs: 25,
      }),
    );
  });
});
