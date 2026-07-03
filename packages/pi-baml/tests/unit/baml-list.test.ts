import { describe, it, expect } from "vitest";
import { createBamlListTool } from "../../src/tools/baml-list.js";
import { FunctionsRegistry } from "../../src/lib/registry.js";
import type { ToolResult } from "../../src/tools/types.js";

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

describe("baml_list tool", () => {
  describe("unfiltered (no group param)", () => {
    it("returns compact groups index", async () => {
      const registry = FunctionsRegistry.fromGroups({
        extraction: {
          "main.baml": `function ExtractItems(text: string) -> Item[] { client PiClient prompt #"..."# }`,
          "README.md": "---\ndescription: Extract structured items\n---",
        },
        classification: {
          "main.baml": `function ClassifyIntent(text: string) -> Intent { client PiClient prompt #"..."# }`,
        },
      });

      const tool = createBamlListTool(registry);
      const result = await tool.execute({});
      const parsed = JSON.parse(textOf(result));

      expect(parsed.groups).toBeDefined();
      expect(parsed.groups).toHaveLength(2);
      // Should be sorted alphabetically
      expect(parsed.groups[0].name).toBe("classification");
      expect(parsed.groups[1].name).toBe("extraction");
      expect(parsed.groups[1].description).toBe("Extract structured items");
      expect(parsed.groups[1].functions).toEqual(["ExtractItems"]);
      // No readme or types in compact output
      expect(parsed.groups[0].readme).toBeUndefined();
    });
  });

  describe("filtered (group param provided)", () => {
    it("returns full GroupDetail", async () => {
      const registry = FunctionsRegistry.fromGroups({
        extraction: {
          "types.baml": `class Item { name string }`,
          "main.baml": `function ExtractItems(text: string) -> Item[] { client PiClient prompt #"..."# }`,
          "README.md": "---\ndescription: Extract items\n---\n\n# Extraction\n\nDetails here.",
        },
      });

      const tool = createBamlListTool(registry);
      const result = await tool.execute({ group: "extraction" });
      const parsed = JSON.parse(textOf(result));

      expect(parsed.group).toBe("extraction");
      expect(parsed.description).toBe("Extract items");
      expect(parsed.readme).toContain("# Extraction");
      expect(parsed.types.length).toBeGreaterThan(0);
      expect(parsed.types[0]).toContain("class Item");
      expect(parsed.functions).toHaveLength(1);
      expect(parsed.functions[0].name).toBe("ExtractItems");
      expect(parsed.functions[0].qualifiedName).toBe("extraction/ExtractItems");
      expect(parsed.functions[0].inputTypes).toBe("text: string");
      expect(parsed.functions[0].outputType).toBe("Item[]");
    });

    it("returns error for nonexistent group", async () => {
      const registry = FunctionsRegistry.fromGroups({
        extraction: {
          "main.baml": `function X(x: string) -> string { client PiClient prompt #""# }`,
        },
      });

      const tool = createBamlListTool(registry);
      const result = await tool.execute({ group: "nonexistent" });
      const parsed = JSON.parse(textOf(result));

      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("nonexistent");
      expect(parsed.error).toContain("not found");
    });
  });

  describe("empty registry", () => {
    it("returns helpful message", async () => {
      const registry = FunctionsRegistry.fromGroups({});
      const tool = createBamlListTool(registry);
      const result = await tool.execute({});
      const text = textOf(result);

      expect(text).toContain("No BAML functions found");
    });
  });
});
