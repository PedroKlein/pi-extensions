import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBamlExecutor } from "../../src/lib/executor.js";

// Mock the @boundaryml/baml module at the system boundary
const mockCallFunction = vi.fn();
const mockCreateContextManager = vi.fn();
const mockFromFiles = vi.fn();
const mockAddLlmClient = vi.fn();
const mockSetPrimary = vi.fn();

vi.mock("@boundaryml/baml", () => ({
  BamlRuntime: {
    fromFiles: (...args: unknown[]) => mockFromFiles(...args),
  },
  ClientRegistry: vi.fn().mockImplementation(() => ({
    addLlmClient: mockAddLlmClient,
    setPrimary: mockSetPrimary,
  })),
  Collector: vi.fn().mockImplementation(() => ({
    last: null,
    logs: [],
  })),
  BamlClientHttpError: {
    from: () => null,
  },
  BamlValidationError: {
    from: () => null,
  },
  BamlClientFinishReasonError: {
    from: () => null,
  },
}));

describe("createBamlExecutor", () => {
  const files = {
    "main.baml": `function Extract(text: string) -> Item[] {
      client "anthropic/claude-4.5-haiku"
      prompt #"..."#
    }`,
  };

  // Pre-built ClientRegistry (mocked) — executor doesn't care about its contents
  // The mock implementation provides addLlmClient/setPrimary
  const mockClientRegistry = {
    addLlmClient: vi.fn(),
    setPrimary: vi.fn(),
  } as unknown as import("@boundaryml/baml").ClientRegistry;

  const mockRuntime = {
    callFunction: mockCallFunction,
    createContextManager: mockCreateContextManager,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFromFiles.mockReturnValue(mockRuntime);
    mockCreateContextManager.mockReturnValue({});
  });

  describe("creation", () => {
    it("compiles valid .baml files without error", () => {
      const executor = createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      expect(executor).toBeDefined();
      expect(mockFromFiles).toHaveBeenCalledWith(
        "/",
        expect.objectContaining({
          ...files,
          "__pi_client.baml": expect.stringContaining("client PiClient"),
        }),
        {},
      );
    });

    it("uses provided syntheticProvider in the placeholder block", () => {
      createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
        syntheticProvider: "openai",
      });

      expect(mockFromFiles).toHaveBeenCalledWith(
        "/",
        expect.objectContaining({
          "__pi_client.baml": expect.stringContaining("provider openai"),
        }),
        {},
      );
    });

    it("defaults syntheticProvider to anthropic", () => {
      createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      expect(mockFromFiles).toHaveBeenCalledWith(
        "/",
        expect.objectContaining({
          "__pi_client.baml": expect.stringContaining("provider anthropic"),
        }),
        {},
      );
    });

    it("throws BamlError with type=compilation on invalid syntax", () => {
      mockFromFiles.mockImplementation(() => {
        throw new Error("Expected '->' but found '{'");
      });

      expect(() =>
        createBamlExecutor({
          files: { "bad.baml": "invalid syntax" },
          clientRegistry: mockClientRegistry,
        }),
      ).toThrow(/BAML compilation failed/);
    });
  });

  describe("call", () => {
    it("executes function and returns parsed result", async () => {
      const mockResult = {
        isOk: () => true,
        parsed: () => [{ description: "do stuff", priority: "high" }],
      };
      mockCallFunction.mockResolvedValue(mockResult);

      const executor = createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      const result = await executor.call("Extract", { text: "meeting notes" });

      expect(result.parsed).toEqual([
        { description: "do stuff", priority: "high" },
      ]);
      expect(result.metadata).toEqual({
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        durationMs: null,
        model: null,
      });
      expect(mockCallFunction).toHaveBeenCalledWith(
        "Extract",
        { text: "meeting notes" },
        expect.anything(), // ctx
        null, // TypeBuilder
        mockClientRegistry, // pre-built ClientRegistry
        expect.anything(), // Collectors
      );
    });

    it("throws with rawOutput when parsing fails", async () => {
      const mockResult = {
        isOk: () => false,
        parsed: () => {
          throw new Error("Failed to parse");
        },
      };
      mockCallFunction.mockResolvedValue(mockResult);

      const executor = createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      await expect(executor.call("Extract", { text: "hi" })).rejects.toThrow(
        /execution/i,
      );
    });
  });

  describe("dispose", () => {
    it("is safe to call multiple times", () => {
      const executor = createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      expect(() => {
        executor.dispose();
        executor.dispose();
        executor.dispose();
      }).not.toThrow();
    });

    it("rejects calls after dispose", async () => {
      const executor = createBamlExecutor({
        files,
        clientRegistry: mockClientRegistry,
      });

      executor.dispose();

      await expect(executor.call("Extract", {})).rejects.toThrow(
        /disposed/,
      );
    });
  });
});
