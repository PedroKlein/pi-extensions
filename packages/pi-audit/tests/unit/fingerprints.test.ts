import { describe, expect, it } from "vitest";
import { createFingerprintStore } from "../../src/fingerprints.js";

const toolA = {
  name: "tool_a",
  description: "Tool A",
  parameters: {
    type: "object",
    properties: { z: { type: "number" }, a: { type: "string" } },
  },
};
const toolB = {
  name: "tool_b",
  description: "Tool B",
  parameters: { type: "object", properties: {} },
};

describe("createFingerprintStore", () => {
  it("tracks prompt and active-tool fingerprints independently", () => {
    const store = createFingerprintStore();

    const first = store.record({
      systemPrompt: "stable prompt",
      tools: [toolB, toolA],
      activeToolNames: ["tool_a", "tool_b"],
    });
    const reordered = store.record({
      systemPrompt: "stable prompt",
      tools: [toolA, toolB],
      activeToolNames: ["tool_b", "tool_a"],
    });
    const promptChanged = store.record({
      systemPrompt: "changed prompt",
      tools: [toolA, toolB],
      activeToolNames: ["tool_a", "tool_b"],
    });

    expect(first.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toMatchObject({
      promptHash: first.promptHash,
      toolHash: first.toolHash,
      promptChanged: false,
      toolsChanged: false,
    });
    expect(promptChanged).toMatchObject({
      toolHash: first.toolHash,
      promptChanged: true,
      toolsChanged: false,
    });
    expect(promptChanged.promptHash).not.toBe(first.promptHash);
    expect(store.report()).toEqual({
      current: promptChanged,
      previous: reordered,
      history: [first, reordered, promptChanged],
    });
  });

  it.each([
    {
      name: "mode switch",
      expectedSource: "mode-switch",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("mode-switch", "build"),
      prompt: "build contract",
      expectedClassification: "expected",
      expectedMode: "build",
    },
    {
      name: "MCP enable or disable",
      expectedSource: "mcp-change",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("mcp-change", "ask"),
      prompt: "ask contract with changed MCP tools",
      expectedClassification: "expected",
      expectedMode: "ask",
    },
    {
      name: "reload",
      expectedSource: "reload",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("reload", "ask"),
      prompt: "reloaded ask contract",
      expectedClassification: "expected",
      expectedMode: "ask",
    },
    {
      name: "resource change",
      expectedSource: "resource-change",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("resource-change", "ask"),
      prompt: "ask contract with refreshed resources",
      expectedClassification: "expected",
      expectedMode: "ask",
    },
    {
      name: "unexplained prompt drift",
      expectedSource: "prompt",
      prepare: (_store: ReturnType<typeof createFingerprintStore>) => undefined,
      prompt: "unexplained dynamic line",
      expectedClassification: "unexpected",
      expectedMode: "ask",
    },
  ])(
    "classifies $name",
    ({
      expectedSource,
      prepare,
      prompt,
      expectedClassification,
      expectedMode,
    }) => {
      const store = createFingerprintStore();
      store.record({
        systemPrompt: "ask contract",
        tools: [toolA],
        activeToolNames: ["tool_a"],
        mode: "ask",
      });

      prepare(store);
      const transition = store.record({
        systemPrompt: prompt,
        tools: [toolA],
        activeToolNames: ["tool_a"],
        mode: expectedMode,
      });

      expect(transition).toMatchObject({
        classification: expectedClassification,
        likelySource: expectedSource,
        mode: expectedMode,
      });
      expect(store.report().previous?.sequence).toBe(1);
      expect(store.report().current?.sequence).toBe(2);
    },
  );
});
