import {
  createAssistantMessageEventStream,
  retryAssistantCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

function quotaFailure(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "backend-a",
    model: "physical-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "402: DAILY_CAP_EXCEEDED",
    timestamp: Date.now(),
  };
}

describe("native virtual-model retry gap", () => {
  it("does not invoke the virtual route again for a configured quota failure", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("backend-a", {
      api: "test-api",
      apiKey: "test-key",
      baseUrl: "https://backend-a.invalid",
      models: [
        {
          id: "physical-model",
          name: "Physical Model",
          api: "test-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        },
      ],
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: "error", reason: "error", error: quotaFailure() }));
        return stream;
      },
    });

    const route = vi.fn(() => ({
      model: runtime.getModel("backend-a", "physical-model")!,
      thinkingLevel: "off" as const,
    }));
    runtime.registerVirtualModel({ provider: "router", id: "auto", route });
    const selected = runtime.getModel("router", "auto")!;
    let failed: AssistantMessage | undefined;

    const result = await retryAssistantCall(
      async () => {
        const resolved = await runtime.resolveModel(selected, [], {
          reason: failed ? "retry" : "user",
          thinkingLevel: "off",
          ...(failed ? { failed } : {}),
        });
        const response = await runtime.completeSimple(resolved.model, { messages: [] });
        if (response.stopReason === "error") failed = response;
        return response;
      },
      { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("DAILY_CAP_EXCEEDED");
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0]).toMatchObject({ reason: "user" });
  });
});
