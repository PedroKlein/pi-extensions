import { describe, it, expect } from "vitest";
import {
  renderBamlExecCall,
  renderBamlRunCall,
  renderBamlListCall,
  renderBamlResult,
  renderBamlListResult,
  formatMetadataFooter,
  formatColoredJson,
} from "../../src/tools/render.js";
import type { BamlCallMetadata } from "../../src/lib/types.js";

/** No-op theme that passes text through unchanged (for assertion clarity). */
const plainTheme = {
  fg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
};

/** Theme that wraps text with markers for color verification. */
const markerTheme = {
  fg(color: string, text: string) { return `[${color}:${text}]`; },
  bold(text: string) { return `<b>${text}</b>`; },
};

describe("render helpers", () => {
  describe("renderBamlExecCall", () => {
    it("shows function name and truncated args", () => {
      const result = renderBamlExecCall(
        { function: "Classify", args: { text: "hello world" }, model: "gpt-4o" },
        plainTheme,
      );
      expect(result).toContain("baml_exec");
      expect(result).toContain("Classify");
      expect(result).toContain("hello world");
      expect(result).toContain("gpt-4o");
    });

    it("handles missing args gracefully", () => {
      const result = renderBamlExecCall(
        { function: "MyFn", args: undefined },
        plainTheme,
      );
      expect(result).toContain("baml_exec");
      expect(result).toContain("MyFn");
    });

    it("truncates long string arguments", () => {
      const longText = "a".repeat(100);
      const result = renderBamlExecCall(
        { function: "Fn", args: { text: longText } },
        plainTheme,
      );
      expect(result).toContain("…");
      expect(result.length).toBeLessThan(200);
    });
  });

  describe("renderBamlRunCall", () => {
    it("shows function name and optional model", () => {
      const result = renderBamlRunCall(
        { function: "ExtractEntities", model: "claude-4.5-haiku" },
        plainTheme,
      );
      expect(result).toContain("baml_run");
      expect(result).toContain("ExtractEntities");
      expect(result).toContain("claude-4.5-haiku");
    });

    it("omits model suffix when not provided", () => {
      const result = renderBamlRunCall(
        { function: "MyFunc" },
        plainTheme,
      );
      expect(result).toContain("baml_run");
      expect(result).toContain("MyFunc");
      expect(result).not.toContain("model");
    });
  });

  describe("renderBamlListCall", () => {
    it("shows group filter when present", () => {
      const result = renderBamlListCall(
        { group: "extraction" },
        plainTheme,
      );
      expect(result).toContain("baml_list");
      expect(result).toContain("extraction");
    });

    it("shows just tool name with no group", () => {
      const result = renderBamlListCall({}, plainTheme);
      expect(result).toContain("baml_list");
    });
  });

  describe("formatMetadataFooter", () => {
    it("formats complete metadata", () => {
      const metadata: BamlCallMetadata = {
        inputTokens: 245,
        outputTokens: 89,
        cachedInputTokens: null,
        durationMs: 1234,
        model: "claude-4.5-haiku",
      };
      const result = formatMetadataFooter(metadata, plainTheme);
      expect(result).toContain("claude-4.5-haiku");
      expect(result).toContain("245 in");
      expect(result).toContain("89 out");
      expect(result).toContain("1.2s");
    });

    it("includes cached tokens when present", () => {
      const metadata: BamlCallMetadata = {
        inputTokens: 500,
        outputTokens: 100,
        cachedInputTokens: 300,
        durationMs: 800,
        model: null,
      };
      const result = formatMetadataFooter(metadata, plainTheme);
      expect(result).toContain("300 cached");
    });

    it("formats sub-second durations in ms", () => {
      const metadata: BamlCallMetadata = {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        durationMs: 450,
        model: null,
      };
      const result = formatMetadataFooter(metadata, plainTheme);
      expect(result).toContain("450ms");
    });

    it("returns empty string when no metadata available", () => {
      const metadata: BamlCallMetadata = {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        durationMs: null,
        model: null,
      };
      const result = formatMetadataFooter(metadata, plainTheme);
      expect(result).toBe("");
    });
  });

  describe("renderBamlResult", () => {
    it("shows pretty JSON and metadata footer for success", () => {
      const result = renderBamlResult(
        {
          content: [{ type: "text", text: JSON.stringify({ label: "positive", score: 0.95 }) }],
          details: {
            metadata: {
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: null,
              durationMs: 1500,
              model: "PiClient",
            },
          },
        },
        plainTheme,
      );
      expect(result).toContain("label");
      expect(result).toContain("positive");
      expect(result).toContain("0.95");
      expect(result).toContain("PiClient");
      expect(result).toContain("100 in");
      expect(result).toContain("1.5s");
    });

    it("shows error with type for BamlError responses", () => {
      const result = renderBamlResult(
        {
          content: [{ type: "text", text: JSON.stringify({ error: "No model found", type: "configuration" }) }],
          details: undefined,
        },
        plainTheme,
      );
      expect(result).toContain("error (configuration)");
      expect(result).toContain("No model found");
    });

    it("shows executing message when partial", () => {
      const result = renderBamlResult(
        { content: [{ type: "text", text: "" }], details: undefined },
        plainTheme,
        true,
      );
      expect(result).toContain("executing");
    });

    it("unwraps enriched result shape and shows model/tier in footer", () => {
      const result = renderBamlResult(
        {
          content: [{ type: "text", text: JSON.stringify({ result: { answer: 42 }, model: "github-copilot/claude-sonnet-4.6", tier: "standard" }) }],
          details: {
            metadata: {
              inputTokens: 200,
              outputTokens: 50,
              cachedInputTokens: null,
              durationMs: 2300,
              model: "PiClient",
            },
          },
        },
        plainTheme,
      );
      // Should display the unwrapped result value, not the wrapper
      expect(result).toContain('"answer"');
      expect(result).toContain("42");
      // Should show the enriched model ref, NOT "PiClient"
      expect(result).toContain("github-copilot/claude-sonnet-4.6");
      expect(result).toContain("(standard)");
      expect(result).not.toContain("PiClient");
      // Token/duration info still present
      expect(result).toContain("200 in");
      expect(result).toContain("50 out");
      expect(result).toContain("2.3s");
    });

    it("shows model/tier in footer even without metadata", () => {
      const result = renderBamlResult(
        {
          content: [{ type: "text", text: JSON.stringify({ result: "hello", model: "hai-proxy/claude-opus", tier: "heavy" }) }],
          details: undefined,
        },
        plainTheme,
      );
      expect(result).toContain("hai-proxy/claude-opus");
      expect(result).toContain("(heavy)");
    });
  });

  describe("renderBamlListResult", () => {
    it("shows function count and groups", () => {
      const functions = [
        { name: "Fn1", group: "a", qualifiedName: "a/Fn1", outputType: "string" },
        { name: "Fn2", group: "b", qualifiedName: "b/Fn2", outputType: "int" },
      ];
      const result = renderBamlListResult(
        { content: [{ type: "text", text: JSON.stringify(functions) }], details: undefined },
        plainTheme,
      );
      expect(result).toContain("2 functions");
      expect(result).toContain("2 groups");
      expect(result).toContain("a/Fn1");
      expect(result).toContain("b/Fn2");
    });

    it("shows message when no functions found", () => {
      const result = renderBamlListResult(
        {
          content: [{ type: "text", text: JSON.stringify({ message: "No BAML functions found." }) }],
          details: undefined,
        },
        plainTheme,
      );
      expect(result).toContain("No BAML functions found.");
    });
  });

  describe("formatColoredJson", () => {
    it("applies theme colors to keys and values", () => {
      const result = formatColoredJson({ name: "test", count: 5 }, markerTheme);
      expect(result).toContain('[accent:"name"]');
      expect(result).toContain('[toolOutput:"test"]');
      expect(result).toContain("[warning:");
    });

    it("truncates output beyond maxLines", () => {
      const bigObj = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`key${i}`, `value${i}`]),
      );
      const result = formatColoredJson(bigObj, plainTheme, 5);
      const lines = result.split("\n");
      expect(lines.length).toBe(6); // 5 lines + truncation message
      expect(result).toContain("more lines");
    });
  });
});
