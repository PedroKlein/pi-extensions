import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseTaskWithLLM } from "../../src/capture.js";

describe("parseTaskWithLLM", () => {
  it("parses through ModelRuntime and reports routed usage", async () => {
    const signal = new AbortController().signal;
    const model = { provider: "router", id: "auto" } as never;
    const response = {
      content: [{
        type: "text",
        text: '{"title":"Fix login","type":"bug","priority":"high"}',
      }],
      provider: "backend-a",
      model: "physical-model",
      stopReason: "stop",
      usage: {
        input: 12,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 1,
        totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const getApiKeyAndHeaders = vi.fn(() => {
      throw new Error("credential lookup must stay inside ModelRuntime");
    });
    const onResponse = vi.fn();
    const registry = { streamSimple, getApiKeyAndHeaders } as unknown as ModelRegistry;

    const result = await parseTaskWithLLM(
      "Fix the login bug urgently",
      model,
      registry,
      signal,
      onResponse,
    );

    expect(result).toMatchObject({
      title: "Fix login",
      type: "bug",
      priority: "high",
    });
    expect(streamSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      { signal },
    );
    expect(onResponse).toHaveBeenCalledWith(response, expect.any(Number));
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });
});
