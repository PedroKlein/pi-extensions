import { describe, expect, it } from "vitest";
import {
  measureStaticBurden,
  type StaticBurdenInput,
  type TokenizerProvenance,
} from "../../src/static-burden.js";

const fixtureTokenizer: TokenizerProvenance = {
  name: "fixture-character-counter",
  provenance: "Deterministic test tokenizer; not an active model tokenizer",
  accuracy: "estimate",
  count: (text) => text.length,
};

const input: StaticBurdenInput = {
  systemPrompt: "Stable system prompt with visible skills",
  skills: [
    {
      name: "personal-skill",
      description: "Personal guidance",
      filePath: "/home/example/.agents/skills/personal-skill/SKILL.md",
      disableModelInvocation: false,
      sourceInfo: { source: "user", origin: "top-level" },
    },
    {
      name: "package-skill",
      description: "Package guidance",
      filePath: "/home/example/.pi/agent/npm/node_modules/example-package/skills/package-skill/SKILL.md",
      disableModelInvocation: false,
      sourceInfo: { source: "example-package", origin: "package" },
    },
    {
      name: "explicit-only-skill",
      description: "Hidden from the system prompt",
      filePath: "/home/example/.agents/skills/explicit-only-skill/SKILL.md",
      disableModelInvocation: true,
      sourceInfo: { source: "user", origin: "top-level" },
    },
  ],
  tools: [
    {
      name: "active_tool",
      description: "Active schema",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      sourceInfo: { source: "example-package", origin: "package" },
    },
    {
      name: "inactive_tool",
      description: "Not sent to the model",
      parameters: { type: "object", properties: {} },
      sourceInfo: { source: "example-package", origin: "package" },
    },
  ],
  activeToolNames: ["active_tool"],
  branchEntries: [
    {
      type: "custom_message",
      customType: "example-context",
      content: "Visible to the model",
      display: false,
    },
    {
      type: "custom",
      customType: "ui-only-state",
      data: { status: "not model-visible" },
    },
  ],
};

describe("measureStaticBurden", () => {
  it("reports every model-visible static burden category without a model call", () => {
    const report = measureStaticBurden(input, fixtureTokenizer);

    expect(report.tokenizer).toEqual({
      name: "fixture-character-counter",
      provenance: "Deterministic test tokenizer; not an active model tokenizer",
      accuracy: "estimate",
    });
    expect(report.categories.systemPrompt.tokens).toBeGreaterThan(0);
    expect(report.categories.skills.personal.count).toBe(1);
    expect(report.categories.skills.personal.tokens).toBeGreaterThan(0);
    expect(report.categories.skills.package.count).toBe(1);
    expect(report.categories.skills.package.tokens).toBeGreaterThan(0);
    expect(report.categories.skills.total.count).toBe(2);
    expect(report.categories.activeToolSchemas.count).toBe(1);
    expect(report.categories.activeToolSchemas.tokens).toBeGreaterThan(0);
    expect(report.categories.modelVisibleCustomMessages.count).toBe(1);
    expect(report.categories.modelVisibleCustomMessages.tokens).toBeGreaterThan(0);
  });
});
