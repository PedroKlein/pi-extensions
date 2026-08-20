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

describe("usage attribution", () => {
  it("attributes malformed-tool retry start and completion", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const emit = vi.fn();
    const sendUserMessage = vi.fn();
    autoRetry({
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers.set(name, handler);
      },
      events: { emit },
      sendUserMessage,
    } as any);
    const ctx = {
      model: { provider: "custom-provider", id: "example-model" },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: vi.fn(),
      },
    };

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Unexpected token in JSON at position 42",
          },
        ],
      },
      ctx,
    );

    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:retry-scheduled",
      expect.objectContaining({ retryLayer: "malformed-tool", attempt: 1 }),
    );
    expect(emit).toHaveBeenCalledWith(
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

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: {
              input: 10,
              cacheRead: 20,
              cacheWrite: 2,
              output: 5,
              reasoning: 1,
            },
          },
        ],
      },
      ctx,
    );

    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-auto-retry",
        operation: "retry-complete",
        input: 10,
        cacheRead: 20,
        cacheWrite: 2,
        output: 5,
        reasoning: 1,
        status: "complete",
        retryLayer: "malformed-tool",
        attempt: 1,
      }),
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
