import { describe, expect, it } from "vitest";
import {
  createFingerprintStore,
  type FingerprintRecord,
} from "../../src/fingerprints.js";

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

  it("drops retired mode metadata from restored records", () => {
    const store = createFingerprintStore([
      {
        sequence: 1,
        promptHash: "prompt",
        toolHash: "tools",
        promptChanged: false,
        toolsChanged: false,
        classification: "initial",
        likelySource: "initial",
        mode: "build",
      } as FingerprintRecord & { mode: string },
    ]);

    expect(store.report().current).not.toHaveProperty("mode");
  });

  it.each([
    {
      name: "reload",
      expectedSource: "reload",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("reload"),
      prompt: "reloaded stable contract",
      expectedClassification: "expected",
    },
    {
      name: "resource change",
      expectedSource: "resource-change",
      prepare: (store: ReturnType<typeof createFingerprintStore>) =>
        store.expectTransition("resource-change"),
      prompt: "stable contract with refreshed resources",
      expectedClassification: "expected",
    },
    {
      name: "unexplained prompt drift",
      expectedSource: "prompt",
      prepare: (_store: ReturnType<typeof createFingerprintStore>) => undefined,
      prompt: "unexplained dynamic line",
      expectedClassification: "unexpected",
    },
  ])(
    "classifies $name",
    ({
      expectedSource,
      prepare,
      prompt,
      expectedClassification,
    }) => {
      const store = createFingerprintStore();
      store.record({
        systemPrompt: "stable contract",
        tools: [toolA],
        activeToolNames: ["tool_a"],
      });

      prepare(store);
      const transition = store.record({
        systemPrompt: prompt,
        tools: [toolA],
        activeToolNames: ["tool_a"],
      });

      expect(transition).toMatchObject({
        classification: expectedClassification,
        likelySource: expectedSource,
      });
      expect(transition).not.toHaveProperty("mode");
      expect(store.report().previous?.sequence).toBe(1);
      expect(store.report().current?.sequence).toBe(2);
    },
  );
});
