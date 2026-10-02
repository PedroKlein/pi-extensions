import { describe, it, expect, vi } from "vitest";
import autoRetry, { isJsonParseError, MAX_RETRIES, RETRY_MESSAGE } from "../../src/index.js";

describe("isJsonParseError", () => {
  it("detects 'unexpected' + 'position' pattern", () => {
    expect(isJsonParseError("Unexpected non-whitespace character after JSON at position 4210")).toBe(true);
  });

  it("detects 'unexpected' + 'json' pattern", () => {
    expect(isJsonParseError("Unexpected token in JSON at position 42")).toBe(true);
  });

  it("detects 'json' + 'parse' pattern", () => {
    expect(isJsonParseError("JSON parse error: unexpected end")).toBe(true);
  });

  it("detects unterminated string", () => {
    expect(isJsonParseError("Unterminated string in JSON")).toBe(true);
  });

  it("detects bad control character", () => {
    expect(isJsonParseError("Bad control character in string literal in JSON")).toBe(true);
  });

  it("detects expected comma or brace", () => {
    expect(isJsonParseError("Expected ',' or '}' after property value in JSON")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isJsonParseError("Network timeout after 30 seconds")).toBe(false);
    expect(isJsonParseError("File not found: /some/path")).toBe(false);
    expect(isJsonParseError("TypeError: Cannot read property of undefined")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isJsonParseError("UNEXPECTED TOKEN IN JSON")).toBe(true);
    expect(isJsonParseError("BAD CONTROL CHARACTER IN STRING")).toBe(true);
  });
});

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
  const emit = vi.fn();
  const notify = vi.fn();
  autoRetry({
    on: (name: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
      handlers.set(name, handler);
    },
    events: { emit },
  } as any);
  const ctx = {
    model: { provider: "custom-provider", id: "example-model" },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify,
    },
  };
  const end = (message: Record<string, unknown>) =>
    handlers.get("agent_end")?.({ messages: [message] }, ctx);
  const turnEnd = (message: Record<string, unknown>) =>
    handlers.get("turn_end")?.({ message }, ctx);
  const settle = (canContinue = true) =>
    handlers.get("agent_before_settle")?.(
      {
        outcome: "error",
        entries: [],
        continue: false,
        context: {
          contextEntries: [],
          contextMessages: [],
          llmMessages: [],
          pendingMessages: [],
          canContinue,
        },
      },
      ctx,
    );
  return { handlers, emit, notify, ctx, end, turnEnd, settle };
}

describe("settlement retry", () => {
  it("adds one hidden retry instruction and continues without a user message", async () => {
    const h = harness();

    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Unexpected token in JSON at position 42",
    });
    const result = await h.settle();
    const duplicate = await h.settle();

    expect(result).toEqual({
      entries: [
        {
          type: "custom_message",
          customType: "pi-auto-retry",
          content: RETRY_MESSAGE,
          display: false,
        },
      ],
      continue: true,
    });
    expect(duplicate).toBeUndefined();
    expect(h.emit).toHaveBeenCalledWith(
      "pi-audit:retry-scheduled",
      expect.objectContaining({ retryLayer: "malformed-tool", attempt: 1 }),
    );
    expect(h.emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-auto-retry",
        operation: "retry-start",
        model: "custom-provider/example-model",
        trigger: "automatic",
        status: "start",
        retryLayer: "malformed-tool",
        attempt: 1,
        route: "custom-provider/example-model",
      }),
    );
  });

  it("records success, resets the limit, and ignores unrelated errors", async () => {
    const h = harness();
    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Unexpected token in JSON at position 42",
    });
    await h.settle();
    const success = {
      role: "assistant",
      stopReason: "stop",
      usage: {
        input: 10,
        cacheRead: 20,
        cacheWrite: 2,
        output: 5,
        reasoning: 1,
      },
    };
    await h.turnEnd(success);
    await h.end(success);

    expect(await h.settle()).toBeUndefined();
    expect(h.emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        operation: "retry-complete",
        input: 10,
        cacheRead: 20,
        cacheWrite: 2,
        output: 5,
        reasoning: 1,
        status: "complete",
        attempt: 1,
      }),
    );

    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Network timeout",
    });
    expect(await h.settle()).toBeUndefined();

    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "JSON parse error",
    });
    expect(await h.settle()).toMatchObject({ continue: true });
    expect(h.emit).toHaveBeenLastCalledWith(
      "pi-audit:usage",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it("does not request a continuation when the boundary cannot continue", async () => {
    const h = harness();
    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "JSON parse error",
    });

    expect(await h.settle(false)).toBeUndefined();
    expect(h.emit).not.toHaveBeenCalledWith(
      "pi-audit:retry-scheduled",
      expect.anything(),
    );
  });

  it("stops after the retry limit", async () => {
    const h = harness();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await h.end({
        role: "assistant",
        stopReason: "error",
        errorMessage: "JSON parse error",
      });
      expect(await h.settle()).toMatchObject({ continue: true });
    }
    await h.end({
      role: "assistant",
      stopReason: "error",
      errorMessage: "JSON parse error",
    });

    expect(await h.settle()).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining(`gave up after ${MAX_RETRIES} attempts`),
      "error",
    );
  });
});

describe("constants", () => {
  it("MAX_RETRIES is 2", () => {
    expect(MAX_RETRIES).toBe(2);
  });

  it("RETRY_MESSAGE instructs smaller edits", () => {
    expect(RETRY_MESSAGE).toContain("malformed JSON");
    expect(RETRY_MESSAGE).toContain("smaller");
  });
});
