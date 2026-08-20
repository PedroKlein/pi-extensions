import { describe, expect, it } from "vitest";
import {
  buildContextHealthReport,
  type ContextHealthInput,
} from "../../src/context-health.js";
import type { TokenizerProvenance } from "../../src/static-burden.js";

const exactFixtureTokenizer: TokenizerProvenance = {
  name: "fixture-character-counter",
  provenance: "Exact character counter for fixture assertions",
  accuracy: "exact",
  count: (text) => text.length,
};

const input: ContextHealthInput = {
  contextTokens: 210_000,
  staticBurden: {
    systemPrompt: "stable prompt",
    skills: [],
    tools: [
      {
        name: "example_tool",
        description: "Example",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "example", origin: "package" },
      },
    ],
    activeToolNames: ["example_tool"],
    branchEntries: [],
  },
  retainedEntries: [
    {
      type: "message",
      id: "user-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "user request" }],
      },
    },
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "assistant answer" },
          {
            type: "toolCall",
            id: "call-1",
            name: "example_tool",
            arguments: { query: "example" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-1",
      message: {
        role: "toolResult",
        toolName: "example_tool",
        content: [{ type: "text", text: "a retained tool result" }],
      },
    },
    {
      type: "custom_message",
      id: "custom-1",
      customType: "example-context",
      content: "model-visible custom context",
      display: false,
    },
  ],
};

describe("buildContextHealthReport", () => {
  it("categorizes retained context, thresholds, and read-only recommendations", () => {
    const report = buildContextHealthReport(input, exactFixtureTokenizer);

    expect(report.tokenizer).toEqual({
      name: "fixture-character-counter",
      provenance: "Exact character counter for fixture assertions",
      accuracy: "exact",
    });
    expect(report.static.systemPrompt.tokens).toBeGreaterThan(0);
    expect(report.static.activeToolSchemas.count).toBe(1);
    expect(report.growth.user.tokens).toBeGreaterThan(0);
    expect(report.growth.assistant.tokens).toBeGreaterThan(0);
    expect(report.growth.reasoning.tokens).toBeGreaterThan(0);
    expect(report.growth.toolResults.tokens).toBeGreaterThan(0);
    expect(report.growth.customMessages.count).toBe(1);
    expect(report.largestToolResults).toEqual([
      expect.objectContaining({
        toolName: "example_tool",
        tokens: "a retained tool result".length,
      }),
    ]);
    expect(report.thresholds).toEqual({
      currentTokens: 210_000,
      crossed: [100_000, 200_000],
      next: 350_000,
    });
    expect(report.recommendations.map((item) => item.command)).toEqual([
      "/compact",
      "/handoff",
      "/new",
    ]);
  });
});
