import { describe, expect, it } from "vitest";
import { createUsageStore, parseUsageEvent } from "../../src/usage.js";

describe("createUsageStore", () => {
  it("aggregates labeled extension-owned usage events", () => {
    const store = createUsageStore();

    store.record({
      source: "example-extension",
      operation: "background-review",
      model: "custom-provider/example-model",
      input: 10,
      cacheRead: 100,
      cacheWrite: 20,
      output: 30,
      reasoning: 5,
      cost: 0.03,
      durationMs: 250,
      trigger: "automatic",
      status: "complete",
    });
    store.record({
      source: "example-extension",
      operation: "manual-review",
      model: "custom-provider/example-model",
      input: 4,
      cacheRead: 120,
      cacheWrite: 0,
      output: 12,
      reasoning: 3,
      cost: 0.02,
      durationMs: 100,
      trigger: "user",
      status: "complete",
    });

    expect(store.report()).toEqual({
      eventCount: 2,
      totals: {
        input: 14,
        cacheRead: 220,
        cacheWrite: 20,
        output: 42,
        reasoning: 8,
        cost: 0.05,
        durationMs: 350,
      },
      bySource: {
        "example-extension": {
          eventCount: 2,
          input: 14,
          cacheRead: 220,
          cacheWrite: 20,
          output: 42,
          reasoning: 8,
          cost: 0.05,
          durationMs: 350,
        },
      },
      events: [
        {
          source: "example-extension",
          operation: "background-review",
          model: "custom-provider/example-model",
          input: 10,
          cacheRead: 100,
          cacheWrite: 20,
          output: 30,
          reasoning: 5,
          cost: 0.03,
          durationMs: 250,
          trigger: "automatic",
          status: "complete",
        },
        {
          source: "example-extension",
          operation: "manual-review",
          model: "custom-provider/example-model",
          input: 4,
          cacheRead: 120,
          cacheWrite: 0,
          output: 12,
          reasoning: 3,
          cost: 0.02,
          durationMs: 100,
          trigger: "user",
          status: "complete",
        },
      ],
    });
  });

  it.each([
    ["pi-memory", "dream-complete"],
    ["pi-subagents-watchdog", "watchdog-review"],
    ["pi-core", "retry-complete"],
    ["pi-gateway", "retry-complete"],
    ["pi-auto-retry", "retry-complete"],
  ])("accepts the mandatory usage contract for %s", (source, operation) => {
    expect(
      parseUsageEvent({
        source,
        operation,
        model: "custom-provider/example-model",
        input: 10,
        cacheRead: 2,
        cacheWrite: 1,
        output: 3,
        reasoning: 4,
        durationMs: 50,
        trigger: "automatic",
        status: "complete",
        ...(operation.startsWith("retry-")
          ? { retryLayer: "core", attempt: 1, route: "custom-provider/example-model" }
          : {}),
      }),
    ).toEqual(expect.objectContaining({ source, operation, status: "complete" }));
  });

  it("defaults legacy events without cost to zero", () => {
    expect(parseUsageEvent({
      source: "example-extension",
      operation: "legacy",
      model: "custom-provider/example-model",
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
      reasoning: 0,
      durationMs: 10,
      trigger: "automatic",
      status: "complete",
    })).toEqual(expect.objectContaining({ cost: 0 }));
  });

  it("rejects incomplete usage events", () => {
    expect(
      parseUsageEvent({
        source: "pi-memory",
        operation: "dream",
        model: "custom-provider/example-model",
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: 0,
        durationMs: 10,
        trigger: "automatic",
      }),
    ).toBeUndefined();
  });
});
