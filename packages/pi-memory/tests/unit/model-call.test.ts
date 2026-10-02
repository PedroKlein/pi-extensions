import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModelCall } from "../../src/model-call.js";

const selected = {
  provider: "router",
  id: "auto",
  name: "Auto",
  api: "test-api",
};

const response = {
  role: "assistant",
  content: [{ type: "text", text: "Memory result" }],
  api: "test-api",
  provider: "backend-a",
  model: "physical-model",
  usage: {
    input: 30,
    output: 8,
    cacheRead: 5,
    cacheWrite: 2,
    reasoning: 3,
    totalTokens: 45,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
};

describe("memory model calls", () => {
  it("resolves configured virtual models and reports physical usage", async () => {
    const signal = new AbortController().signal;
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const report = vi.fn();
    const call = createModelCall({
      model: undefined,
      modelRegistry: { getAll: () => [selected], streamSimple } as unknown as ModelRegistry,
    }, report);

    await expect(call({
      model: "router/auto:medium",
      systemPrompt: "Extract memory",
      prompt: "Conversation",
      operation: "memory-consolidate",
      trigger: "automatic",
      signal,
    })).resolves.toBe("Memory result");

    expect(streamSimple).toHaveBeenCalledWith(
      selected,
      expect.objectContaining({
        systemPrompt: "Extract memory",
        messages: [expect.objectContaining({ role: "user" })],
      }),
      { signal, reasoning: "medium" },
    );
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      source: "pi-memory",
      operation: "memory-consolidate",
      model: "router/auto",
      route: "backend-a/physical-model",
      input: 30,
      output: 8,
      cost: 0.03,
      trigger: "automatic",
      status: "complete",
    }));
  });

  it("reports unavailable configured models without starting a request", async () => {
    const streamSimple = vi.fn();
    const report = vi.fn();
    const call = createModelCall({
      model: selected as never,
      modelRegistry: { getAll: () => [selected], streamSimple } as unknown as ModelRegistry,
    }, report);

    await expect(call({
      model: "missing/model",
      systemPrompt: "Extract memory",
      prompt: "Conversation",
      operation: "memory-consolidate",
    })).rejects.toThrow("Configured model is unavailable: missing/model");
    expect(streamSimple).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      model: "missing/model",
      status: "error",
      input: 0,
      output: 0,
    }));
  });

  it("propagates cancellation and reports aborted usage once", async () => {
    const controller = new AbortController();
    const aborted = { ...response, content: [], stopReason: "aborted" };
    const streamSimple = vi.fn().mockImplementation((_model, _context, options) => ({
      result: async () => {
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return aborted;
      },
    }));
    const report = vi.fn();
    const call = createModelCall({
      model: selected as never,
      modelRegistry: { getAll: () => [selected], streamSimple } as unknown as ModelRegistry,
    }, report);

    const pending = call({
      systemPrompt: "Extract memory",
      prompt: "Conversation",
      operation: "memory-consolidate",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      model: "router/auto",
      route: "backend-a/physical-model",
      status: "error",
      input: 30,
      output: 8,
    }));
  });
});
