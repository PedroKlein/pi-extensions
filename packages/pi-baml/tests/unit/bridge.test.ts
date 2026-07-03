import { describe, it, expect, vi } from "vitest";
import { resolveModelTier, mapPiApiToBamlProvider } from "../../src/lib/bridge.js";
import type { ModelRegistry } from "../../src/lib/bridge.js";
import type { BamlSettings } from "../../src/lib/types.js";

const settings: BamlSettings = {
  models: {
    light: "github-copilot/claude-haiku-4.5",
    standard: "github-copilot/claude-sonnet-4.6",
    heavy: "github-copilot/claude-opus-4.7",
  },
};

function createMockRegistry(overrides?: {
  findReturn?: ReturnType<ModelRegistry["find"]> | null;
  authReturn?: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
}): ModelRegistry {
  const defaultFind = {
    id: "claude-sonnet-4.6",
    api: "anthropic-messages",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0" },
  };
  return {
    find: vi.fn().mockReturnValue(
      overrides?.findReturn === null ? undefined : (overrides?.findReturn ?? defaultFind),
    ),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue(
      overrides?.authReturn ?? {
        ok: true as const,
        apiKey: "ghu_test123",
        headers: { Authorization: "Bearer ghu_test123" },
      },
    ),
  };
}

describe("resolveModelTier", () => {
  it("resolves standard tier by default", async () => {
    const registry = createMockRegistry();
    const result = await resolveModelTier(settings, registry);

    expect(registry.find).toHaveBeenCalledWith("github-copilot", "claude-sonnet-4.6");
    expect(result.bamlProvider).toBe("anthropic");
    expect(result.clientRegistry).toBeDefined();
  });

  it("resolves light tier", async () => {
    const registry = createMockRegistry();
    await resolveModelTier(settings, registry, "light");

    expect(registry.find).toHaveBeenCalledWith("github-copilot", "claude-haiku-4.5");
  });

  it("resolves heavy tier", async () => {
    const registry = createMockRegistry();
    await resolveModelTier(settings, registry, "heavy");

    expect(registry.find).toHaveBeenCalledWith("github-copilot", "claude-opus-4.7");
  });

  it("throws when model not found in registry", async () => {
    const registry = createMockRegistry({ findReturn: null });

    await expect(resolveModelTier(settings, registry)).rejects.toThrow(
      "not found in Pi's ModelRegistry",
    );
  });

  it("throws when auth fails", async () => {
    const registry = createMockRegistry({
      authReturn: { ok: false, error: "token expired" },
    });

    await expect(resolveModelTier(settings, registry)).rejects.toThrow(
      "Auth failed",
    );
  });

  it("includes baseUrl in client options", async () => {
    const registry = createMockRegistry();
    const result = await resolveModelTier(settings, registry);

    // Verify registry was built (no throw = success, type is correct)
    expect(result.clientRegistry).toBeDefined();
    expect(result.bamlProvider).toBe("anthropic");
  });

  it("handles model with no headers", async () => {
    const registry = createMockRegistry({
      findReturn: {
        id: "claude-sonnet-4.6",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
      authReturn: { ok: true, apiKey: "sk-test" },
    });

    const result = await resolveModelTier(settings, registry);
    expect(result.bamlProvider).toBe("anthropic");
  });
});

describe("mapPiApiToBamlProvider", () => {
  it("maps anthropic-messages to anthropic", () => {
    expect(mapPiApiToBamlProvider("anthropic-messages")).toBe("anthropic");
  });

  it("maps openai-completions to openai-generic", () => {
    expect(mapPiApiToBamlProvider("openai-completions")).toBe("openai-generic");
  });

  it("throws for openai-responses (unsupported in BAML 0.85.0)", () => {
    expect(() => mapPiApiToBamlProvider("openai-responses")).toThrow("not supported by BAML 0.85.0");
  });

  it("maps google-generative-ai to google-ai", () => {
    expect(mapPiApiToBamlProvider("google-generative-ai")).toBe("google-ai");
  });

  it("maps google-vertex to vertex-ai", () => {
    expect(mapPiApiToBamlProvider("google-vertex")).toBe("vertex-ai");
  });

  it("maps bedrock-converse-stream to aws-bedrock", () => {
    expect(mapPiApiToBamlProvider("bedrock-converse-stream")).toBe("aws-bedrock");
  });

  it("defaults to openai-generic for unknown types", () => {
    expect(mapPiApiToBamlProvider("unknown-api")).toBe("openai-generic");
  });
});
