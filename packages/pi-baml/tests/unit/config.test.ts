import { describe, it, expect } from "vitest";
import { parseBamlSettings } from "../../src/lib/config.js";

describe("parseBamlSettings", () => {
  const validSettings = {
    baml: {
      models: {
        light: "github-copilot/claude-haiku-4.5",
        standard: "github-copilot/claude-sonnet-4.6",
        heavy: "github-copilot/claude-opus-4.7",
      },
    },
  };

  it("parses valid settings with all three tiers", () => {
    const result = parseBamlSettings(validSettings);
    expect(result.models.light).toBe("github-copilot/claude-haiku-4.5");
    expect(result.models.standard).toBe("github-copilot/claude-sonnet-4.6");
    expect(result.models.heavy).toBe("github-copilot/claude-opus-4.7");
  });

  it("parses functionsDirs when present", () => {
    const result = parseBamlSettings({
      baml: {
        models: validSettings.baml.models,
        functionsDirs: ["/custom/dir", "/another"],
      },
    });
    expect(result.functionsDirs).toEqual(["/custom/dir", "/another"]);
  });

  it("omits functionsDirs when absent", () => {
    const result = parseBamlSettings(validSettings);
    expect(result.functionsDirs).toBeUndefined();
  });

  it("throws when settings is null", () => {
    expect(() => parseBamlSettings(null)).toThrow("Missing settings");
  });

  it("throws when baml section missing", () => {
    expect(() => parseBamlSettings({})).toThrow("Missing 'baml' section");
  });

  it("throws when models section missing", () => {
    expect(() => parseBamlSettings({ baml: {} })).toThrow("Missing 'baml.models'");
  });

  it("throws when a tier is missing", () => {
    expect(() => parseBamlSettings({
      baml: { models: { light: "a/b", standard: "a/b" } },
    })).toThrow("baml.models.heavy");
  });

  it("throws when tier value has no slash", () => {
    expect(() => parseBamlSettings({
      baml: { models: { light: "no-slash", standard: "a/b", heavy: "a/b" } },
    })).toThrow("Must be \"provider/model-id\" format");
  });

  it("throws when tier value is empty string", () => {
    expect(() => parseBamlSettings({
      baml: { models: { light: "", standard: "a/b", heavy: "a/b" } },
    })).toThrow("baml.models.light");
  });

  it("filters empty strings from functionsDirs", () => {
    const result = parseBamlSettings({
      baml: {
        models: validSettings.baml.models,
        functionsDirs: ["valid", "", "  "],
      },
    });
    expect(result.functionsDirs).toEqual(["valid"]);
  });

  it("returns systemPrompt: true by default", () => {
    const result = parseBamlSettings(validSettings);
    expect(result.systemPrompt).toBe(true);
  });

  it("accepts explicit systemPrompt: false", () => {
    const result = parseBamlSettings({
      baml: { ...validSettings.baml, systemPrompt: false },
    });
    expect(result.systemPrompt).toBe(false);
  });

  it("accepts explicit systemPrompt: true", () => {
    const result = parseBamlSettings({
      baml: { ...validSettings.baml, systemPrompt: true },
    });
    expect(result.systemPrompt).toBe(true);
  });

  it("rejects non-boolean systemPrompt", () => {
    expect(() =>
      parseBamlSettings({
        baml: { ...validSettings.baml, systemPrompt: "yes" },
      }),
    ).toThrow("Invalid 'baml.systemPrompt': must be a boolean");
  });
});
