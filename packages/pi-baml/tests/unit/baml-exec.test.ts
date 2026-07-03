import { describe, it, expect, vi } from "vitest";
import { createBamlExecTool } from "../../src/tools/baml-exec.js";
import type { BamlSettings } from "../../src/lib/types.js";
import type { ToolContext } from "../../src/tools/types.js";

const settings: BamlSettings = {
  models: {
    light: "github-copilot/claude-haiku-4.5",
    standard: "github-copilot/claude-sonnet-4.6",
    heavy: "github-copilot/claude-opus-4.7",
  },
};

function mockRegistry() {
  return {
    find: vi.fn().mockReturnValue({
      id: "claude-sonnet-4.6",
      api: "anthropic-messages",
      baseUrl: "https://api.individual.githubcopilot.com",
      headers: { "User-Agent": "test" },
    }),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({
      ok: true as const,
      apiKey: "test-key",
      headers: {},
    }),
  };
}

function mockExecutorFactory() {
  return vi.fn().mockReturnValue({
    call: vi.fn().mockResolvedValue({
      parsed: { result: "ok" },
      metadata: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, durationMs: 100, model: null },
    }),
    dispose: vi.fn(),
  });
}

describe("baml_exec tool", () => {
  it("uses standard tier by default", async () => {
    const factory = mockExecutorFactory();
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { code: "test code", function: "Foo", args: {} },
      ctx,
    );

    expect(ctx.modelRegistry!.find).toHaveBeenCalledWith("github-copilot", "claude-sonnet-4.6");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({ result: { result: "ok" }, model: "github-copilot/claude-sonnet-4.6", tier: "standard" });
  });

  it("uses light tier when specified", async () => {
    const factory = mockExecutorFactory();
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    await tool.execute(
      { code: "test", function: "Foo", args: {}, model: "light" },
      ctx,
    );

    expect(ctx.modelRegistry!.find).toHaveBeenCalledWith("github-copilot", "claude-haiku-4.5");
  });

  it("uses heavy tier when specified", async () => {
    const factory = mockExecutorFactory();
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    await tool.execute(
      { code: "test", function: "Foo", args: {}, model: "heavy" },
      ctx,
    );

    expect(ctx.modelRegistry!.find).toHaveBeenCalledWith("github-copilot", "claude-opus-4.7");
  });

  it("returns configuration error when modelRegistry missing", async () => {
    const factory = mockExecutorFactory();
    const tool = createBamlExecTool(settings, factory);

    const result = await tool.execute(
      { code: "test", function: "Foo", args: {} },
      { modelRegistry: undefined },
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("configuration");
    expect(error.error).toContain("modelRegistry");
  });

  it("returns configuration error when model not found", async () => {
    const factory = mockExecutorFactory();
    const tool = createBamlExecTool(settings, factory);
    const reg = mockRegistry();
    reg.find.mockReturnValue(undefined);

    const result = await tool.execute(
      { code: "test", function: "Foo", args: {} },
      { modelRegistry: reg },
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("configuration");
    expect(error.error).toContain("not found");
  });

  it("returns execution error on BAML failure", async () => {
    const factory = vi.fn().mockReturnValue({
      call: vi.fn().mockRejectedValue(new Error("LLM failed")),
      dispose: vi.fn(),
    });
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { code: "test", function: "Foo", args: {} },
      ctx,
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("execution");
    expect(error.error).toContain("LLM failed");
  });

  it("passes bamlError through when present", async () => {
    const bamlError = { error: "parse failed", type: "execution" as const, rawOutput: "bad json" };
    const err = Object.assign(new Error("parse failed"), { bamlError });
    const factory = vi.fn().mockReturnValue({
      call: vi.fn().mockRejectedValue(err),
      dispose: vi.fn(),
    });
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { code: "test", function: "Foo", args: {} },
      ctx,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.rawOutput).toBe("bad json");
  });

  it("disposes executor after call", async () => {
    const dispose = vi.fn();
    const factory = vi.fn().mockReturnValue({
      call: vi.fn().mockResolvedValue({ parsed: {}, metadata: {} }),
      dispose,
    });
    const tool = createBamlExecTool(settings, factory);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    await tool.execute({ code: "test", function: "Foo", args: {} }, ctx);
    expect(dispose).toHaveBeenCalled();
  });
});
