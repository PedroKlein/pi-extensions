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
  content: [{ type: "text", text: "Repository summary" }],
  api: "test-api",
  provider: "backend-a",
  model: "physical-model",
  usage: {
    input: 20,
    output: 5,
    cacheRead: 4,
    cacheWrite: 1,
    reasoning: 2,
    totalTokens: 30,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
};

describe("repository model calls", () => {
  it("resolves configured virtual models and reports the physical route", async () => {
    const signal = new AbortController().signal;
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const modelRegistry = {
      getAll: () => [selected],
      streamSimple,
      getApiKeyAndHeaders: vi.fn(() => {
        throw new Error("credential lookup must stay inside ModelRuntime");
      }),
    } as unknown as ModelRegistry;
    const report = vi.fn();
    const call = createModelCall({ modelRegistry, model: undefined }, report);

    await expect(call({
      model: "router/auto:high",
      systemPrompt: "Summarize repositories",
      prompt: "Describe this repository",
      operation: "repo-summary",
      signal,
    })).resolves.toBe("Repository summary");

    expect(streamSimple).toHaveBeenCalledWith(
      selected,
      {
        systemPrompt: "Summarize repositories",
        messages: [expect.objectContaining({ role: "user", content: [{ type: "text", text: "Describe this repository" }] })],
      },
      { signal, reasoning: "high" },
    );
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      source: "pi-repos",
      operation: "repo-summary",
      model: "router/auto",
      route: "backend-a/physical-model",
      input: 20,
      output: 5,
      cost: 0.03,
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
      systemPrompt: "System",
      prompt: "Prompt",
      operation: "repo-summary",
    })).rejects.toThrow("Configured model is unavailable: missing/model");

    expect(streamSimple).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      model: "missing/model",
      operation: "repo-summary",
      status: "error",
      input: 0,
      output: 0,
    }));
  });

  it("propagates cancellation and reports aborted provider usage once", async () => {
    const controller = new AbortController();
    const aborted = {
      ...response,
      content: [],
      stopReason: "aborted",
      errorMessage: "cancelled",
    };
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
      systemPrompt: "System",
      prompt: "Prompt",
      operation: "repo-summary",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      model: "router/auto",
      route: "backend-a/physical-model",
      status: "error",
      input: 20,
      output: 5,
    }));
  });
});
