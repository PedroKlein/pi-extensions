import { describe, it, expect, vi } from "vitest";
import { createPiBamlLibrary } from "../../src/eventbus.js";
import { FunctionsRegistry } from "../../src/lib/registry.js";
import type { BamlSettings, ModelRegistry } from "../../src/lib/types.js";

// Mock BAML runtime
vi.mock("@boundaryml/baml", () => ({
  BamlRuntime: {
    fromFiles: vi.fn().mockReturnValue({
      createContextManager: vi.fn().mockReturnValue({}),
      callFunction: vi.fn().mockResolvedValue({
        isOk: () => true,
        parsed: () => ({ answer: "42" }),
      }),
    }),
  },
  ClientRegistry: vi.fn().mockImplementation(() => ({
    addLlmClient: vi.fn(),
    setPrimary: vi.fn(),
  })),
  Collector: vi.fn().mockImplementation(() => ({ last: null })),
}));

const settings: BamlSettings = {
  models: {
    light: "github-copilot/claude-haiku-4.5",
    standard: "github-copilot/claude-sonnet-4.6",
    heavy: "github-copilot/claude-opus-4.7",
  },
};

function createMockModelRegistry(): ModelRegistry {
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

describe("createPiBamlLibrary", () => {
  it("returns available=true when BAML is available", () => {
    const lib = createPiBamlLibrary({ available: true, settings });
    expect(lib.available).toBe(true);
  });

  it("returns available=false when BAML is unavailable", () => {
    const lib = createPiBamlLibrary({ available: false, loadError: "native binary missing", settings });
    expect(lib.available).toBe(false);
  });

  it("throws on method call when unavailable", async () => {
    const lib = createPiBamlLibrary({ available: false, loadError: "test", settings });
    const mockRegistry = createMockModelRegistry();
    await expect(lib.execBaml("code", "fn", {}, mockRegistry)).rejects.toThrow("unavailable");
  });

  it("execBaml works with modelRegistry passed directly", async () => {
    const lib = createPiBamlLibrary({ available: true, settings });
    const mockRegistry = createMockModelRegistry();

    // execBaml should attempt to compile (may fail on BAML compilation,
    // but should NOT throw "not initialized" or deadlock)
    try {
      await lib.execBaml("invalid baml", "fn", {}, mockRegistry);
    } catch (err) {
      expect((err as Error).message).not.toContain("not initialized");
    }
  });

  it("createExecutor works with modelRegistry passed directly", async () => {
    const lib = createPiBamlLibrary({ available: true, settings });
    const mockRegistry = createMockModelRegistry();

    // Should attempt to compile without deadlock
    try {
      await lib.createExecutor({ "test.baml": "invalid" }, mockRegistry, "light");
    } catch (err) {
      expect((err as Error).message).not.toContain("not initialized");
    }
  });

  it("list returns empty when no functions registered", () => {
    const lib = createPiBamlLibrary({ available: true, settings });
    expect(lib.list()).toEqual([]);
  });

  it("setRegistry updates the functions registry", () => {
    const lib = createPiBamlLibrary({ available: true, settings });
    const reg = FunctionsRegistry.fromGroups({
      "test": { "main.baml": "function Foo(x: string) -> string { client PiClient\n  prompt #\"{{ x }}\"# }" },
    });
    lib.setRegistry(reg);
    const list = lib.list();
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("Foo");
  });
});
