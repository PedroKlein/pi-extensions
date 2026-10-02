import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChatEngine } from "../../src/chat/engine.js";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    api: "test-api",
    provider: "backend-a",
    model: "physical-model",
    usage: {
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 1,
      totalTokens: 21,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function eventStream(events: AssistantMessageEvent[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function context(streamSimple: ReturnType<typeof vi.fn>): ExtensionContext {
  return {
    model: { provider: "router", id: "auto", name: "Auto" },
    modelRegistry: {
      streamSimple,
      getApiKeyAndHeaders: vi.fn(() => {
        throw new Error("credential lookup must stay inside ModelRuntime");
      }),
    },
  } as unknown as ExtensionContext;
}

describe("ChatEngine", () => {
  it("streams the selected model with cancellation, partial output, and usage attribution", async () => {
    const final = message();
    const partial = message({ content: [{ type: "text", text: "Hello" }], stopReason: "pending" });
    const streamSimple = vi.fn().mockReturnValue(eventStream([
      { type: "text_delta", contentIndex: 0, delta: "Hello", partial },
      { type: "text_delta", contentIndex: 0, delta: " world", partial },
      { type: "done", reason: "stop", message: final },
    ]));
    const signal = new AbortController().signal;
    const chunks: string[] = [];
    const onResponse = vi.fn();
    const ctx = context(streamSimple);
    const engine = new ChatEngine(ctx, undefined, onResponse);

    await expect(engine.send("Hi", signal, (chunk) => chunks.push(chunk))).resolves.toBe("Hello world");

    expect(streamSimple).toHaveBeenCalledWith(
      ctx.model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("helpful assistant in a side-chat"),
        messages: [expect.objectContaining({ role: "user" })],
      }),
      { signal },
    );
    expect(chunks).toEqual(["Hello", " world"]);
    expect(engine.getUsage()).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      contextTokens: 21,
      cost: 0.03,
      turns: 1,
    });
    expect(onResponse).toHaveBeenCalledWith(final, expect.any(Number), ctx.model);
  });

  it("propagates aborts to the active runtime stream", async () => {
    const controller = new AbortController();
    const aborted = message({ content: [], stopReason: "aborted" });
    const streamSimple = vi.fn().mockImplementation((_model, _context, options) => ({
      async *[Symbol.asyncIterator]() {
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        yield { type: "error", reason: "aborted", error: aborted } as AssistantMessageEvent;
      },
    }));
    const onResponse = vi.fn();
    const engine = new ChatEngine(context(streamSimple), undefined, onResponse);

    const pending = engine.send("Hi", controller.signal);
    controller.abort();

    await expect(pending).resolves.toBe("");
    expect(streamSimple.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(onResponse).toHaveBeenCalledWith(aborted, expect.any(Number), expect.objectContaining({ id: "auto" }));
    expect(engine.streaming).toBe(false);
  });

  it("surfaces terminal provider errors and attributes their usage", async () => {
    const failure = message({
      content: [],
      stopReason: "error",
      errorMessage: "provider unavailable",
    });
    const streamSimple = vi.fn().mockReturnValue(eventStream([
      { type: "error", reason: "error", error: failure },
    ]));
    const onResponse = vi.fn();
    const engine = new ChatEngine(context(streamSimple), undefined, onResponse);

    await expect(engine.send("Hi")).resolves.toContain("Error: provider unavailable");
    expect(onResponse).toHaveBeenCalledWith(failure, expect.any(Number), expect.objectContaining({ id: "auto" }));
  });

  it("summarizes through ModelRuntime without resolving credentials", async () => {
    const final = message({ content: [{ type: "text", text: "Concise summary" }] });
    const result = vi.fn().mockResolvedValue(final);
    const streamSimple = vi.fn().mockReturnValue({ result });
    const ctx = context(streamSimple);
    const engine = new ChatEngine(ctx);

    await expect(engine.summarize()).resolves.toBe("Concise summary");
    expect(streamSimple).toHaveBeenCalledWith(
      ctx.model,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      {},
    );
  });
});
