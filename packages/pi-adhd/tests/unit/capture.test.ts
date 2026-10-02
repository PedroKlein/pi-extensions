import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { classifyHeuristic, classifyNote } from "../../src/notes/capture.js";

describe("capture", () => {
  it("classifies through ModelRuntime without resolving credentials", async () => {
    const signal = new AbortController().signal;
    const model = { provider: "router", id: "auto" } as never;
    const response = {
      content: [{ type: "text", text: '{"title":"Auth notes","category":"reference"}' }],
      provider: "backend-a",
      model: "physical-model",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    };
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const getApiKeyAndHeaders = vi.fn(() => {
      throw new Error("credential lookup must stay inside ModelRuntime");
    });
    const onResponse = vi.fn();

    await expect(classifyNote("Auth uses JWT", {
      model,
      modelRegistry: { streamSimple, getApiKeyAndHeaders } as unknown as ModelRegistry,
      signal,
      onResponse,
    })).resolves.toEqual({
      title: "Auth notes",
      content: "Auth uses JWT",
      category: "reference",
    });

    expect(streamSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("classifying a quick note"),
        messages: [expect.objectContaining({ role: "user" })],
      }),
      expect.objectContaining({ signal, maxTokens: 150, temperature: 0 }),
    );
    expect(onResponse).toHaveBeenCalledWith(response, expect.any(Number));
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  describe("classifyHeuristic", () => {
    it("defaults to prompt category for action-like text", () => {
      const result = classifyHeuristic("Generate ADRs for decisions");
      expect(result.category).toBe("prompt");
      expect(result.title).toBe("Generate ADRs for decisions");
      expect(result.content).toBe("Generate ADRs for decisions");
    });

    it("detects reminder keywords", () => {
      const result = classifyHeuristic("Don't forget to push before the meeting");
      expect(result.category).toBe("reminder");
    });

    it("detects reference keywords", () => {
      const result = classifyHeuristic("Auth service uses JWT with RS256");
      expect(result.category).toBe("reference");
    });

    it("truncates long titles at sentence boundary", () => {
      const longText = "a".repeat(100) + ". Second sentence here.";
      const result = classifyHeuristic(longText);
      expect(result.title.length).toBeLessThanOrEqual(50);
      expect(result.title.endsWith("...")).toBe(true);
    });

    it("uses first sentence as title", () => {
      const result = classifyHeuristic("Fix the login bug. Also check the tests.");
      expect(result.title).toBe("Fix the login bug");
    });

    it("preserves short single-sentence text as-is", () => {
      const result = classifyHeuristic("Quick note");
      expect(result.title).toBe("Quick note");
    });
  });
});
