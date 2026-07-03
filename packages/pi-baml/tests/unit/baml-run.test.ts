import { describe, it, expect, vi } from "vitest";
import { createBamlRunTool } from "../../src/tools/baml-run.js";
import { FunctionsRegistry } from "../../src/lib/registry.js";
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
      headers: {},
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
      parsed: [{ task: "do thing" }],
      metadata: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, durationMs: 100, model: null },
    }),
    dispose: vi.fn(),
  });
}

const testFiles = {
  "main.baml": `function TestFunc(input: string) -> string {
  client PiClient
  prompt #"{{ input }}"#
}`,
};

function createTestRegistry() {
  return FunctionsRegistry.fromGroups({
    "test-group": testFiles,
  });
}

describe("baml_run tool", () => {
  it("resolves function and uses standard tier by default", async () => {
    const factory = mockExecutorFactory();
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { function: "TestFunc", args: { input: "hello" } },
      ctx,
    );

    expect(ctx.modelRegistry!.find).toHaveBeenCalledWith("github-copilot", "claude-sonnet-4.6");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({ result: [{ task: "do thing" }], model: "github-copilot/claude-sonnet-4.6", tier: "standard" });
  });

  it("uses light tier when specified", async () => {
    const factory = mockExecutorFactory();
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    await tool.execute(
      { function: "TestFunc", args: {}, model: "light" },
      ctx,
    );

    expect(ctx.modelRegistry!.find).toHaveBeenCalledWith("github-copilot", "claude-haiku-4.5");
  });

  it("returns error when function not found", async () => {
    const factory = mockExecutorFactory();
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { function: "NonExistent", args: {} },
      ctx,
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("configuration");
  });

  it("returns error when modelRegistry missing", async () => {
    const factory = mockExecutorFactory();
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);

    const result = await tool.execute(
      { function: "TestFunc", args: {} },
      { modelRegistry: undefined },
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("configuration");
    expect(error.error).toContain("modelRegistry");
  });

  it("returns execution error on BAML failure", async () => {
    const factory = vi.fn().mockReturnValue({
      call: vi.fn().mockRejectedValue(new Error("timeout")),
      dispose: vi.fn(),
    });
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    const result = await tool.execute(
      { function: "TestFunc", args: {} },
      ctx,
    );

    const error = JSON.parse(result.content[0]!.text);
    expect(error.type).toBe("execution");
  });

  it("passes function args to executor", async () => {
    const callFn = vi.fn().mockResolvedValue({
      parsed: "result",
      metadata: { inputTokens: null, outputTokens: null, cachedInputTokens: null, durationMs: null, model: null },
    });
    const factory = vi.fn().mockReturnValue({ call: callFn, dispose: vi.fn() });
    const registry = createTestRegistry();
    const tool = createBamlRunTool(registry, factory, settings);
    const ctx: ToolContext = { modelRegistry: mockRegistry() };

    await tool.execute(
      { function: "TestFunc", args: { input: "hello world" } },
      ctx,
    );

    expect(callFn).toHaveBeenCalledWith("TestFunc", { input: "hello world" });
  });
});
