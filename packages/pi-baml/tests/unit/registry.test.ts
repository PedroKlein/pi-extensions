import { describe, it, expect } from "vitest";
import {
  parseFunctionDeclarations,
  FunctionsRegistry,
} from "../../src/lib/registry.js";

describe("parseFunctionDeclarations", () => {
  it("extracts function name, input params, and return type", () => {
    const source = `
function ExtractActionItems(meeting_notes: string) -> ActionItem[] {
  client "anthropic/claude-4.5-haiku"
  prompt #"..."#
}`;
    const result = parseFunctionDeclarations(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "ExtractActionItems",
      inputTypes: "meeting_notes: string",
      outputType: "ActionItem[]",
    });
  });

  it("handles multiple functions per file", () => {
    const source = `
function Classify(text: string) -> Category {
  client PiClient
  prompt #"..."#
}

function Summarize(text: string, max_length: int) -> string {
  client PiClient
  prompt #"..."#
}`;
    const result = parseFunctionDeclarations(source);

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("Classify");
    expect(result[0]!.inputTypes).toBe("text: string");
    expect(result[1]!.name).toBe("Summarize");
    expect(result[1]!.inputTypes).toBe("text: string, max_length: int");
    expect(result[1]!.outputType).toBe("string");
  });

  it("handles complex return types", () => {
    const source = `
function Extract(doc: string) -> ExtractResult | Error {
  client PiClient
  prompt #"..."#
}`;
    const result = parseFunctionDeclarations(source);

    expect(result[0]!.outputType).toBe("ExtractResult | Error");
  });

  it("returns empty array for files without functions", () => {
    const source = `
class ActionItem {
  description string
  priority "high" | "medium" | "low"
}`;
    const result = parseFunctionDeclarations(source);

    expect(result).toEqual([]);
  });
});

describe("FunctionsRegistry", () => {
  function createRegistry(
    groups: Record<string, Record<string, string>>,
  ): FunctionsRegistry {
    return FunctionsRegistry.fromGroups(groups);
  }

  describe("resolve by short name (unambiguous)", () => {
    it("resolves when function exists in only one group", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function ExtractActionItems(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
        },
        classification: {
          "main.baml": `function ClassifyIntent(text: string) -> Intent {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      const entry = registry.resolve("ExtractActionItems");
      expect(entry.name).toBe("ExtractActionItems");
      expect(entry.group).toBe("extraction");
      expect(entry.inputTypes).toBe("text: string");
      expect(entry.outputType).toBe("Item[]");
    });
  });

  describe("resolve by qualified name", () => {
    it("resolves with group/name format", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function Summarize(text: string) -> string {
            client PiClient
            prompt #"..."#
          }`,
        },
        transformation: {
          "main.baml": `function Summarize(text: string) -> Summary {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      const entry = registry.resolve("extraction/Summarize");
      expect(entry.name).toBe("Summarize");
      expect(entry.group).toBe("extraction");
      expect(entry.outputType).toBe("string");
    });
  });

  describe("ambiguous short name", () => {
    it("throws with hint listing qualified names", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function Summarize(text: string) -> string {
            client PiClient
            prompt #"..."#
          }`,
        },
        transformation: {
          "main.baml": `function Summarize(text: string) -> Summary {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      expect(() => registry.resolve("Summarize")).toThrow(
        /Ambiguous function name 'Summarize'/,
      );
      expect(() => registry.resolve("Summarize")).toThrow(
        /extraction\/Summarize/,
      );
      expect(() => registry.resolve("Summarize")).toThrow(
        /transformation\/Summarize/,
      );
    });
  });

  describe("unknown function", () => {
    it("throws with clear message", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function Extract(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      expect(() => registry.resolve("NonExistent")).toThrow(
        /Function 'NonExistent' not found/,
      );
    });
  });

  describe("list", () => {
    it("returns all FunctionInfo entries", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function ExtractItems(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
        },
        classification: {
          "main.baml": `function ClassifyIntent(text: string) -> Intent {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((f) => f.name).sort()).toEqual([
        "ClassifyIntent",
        "ExtractItems",
      ]);
      expect(list[0]!.qualifiedName).toMatch(/\w+\/\w+/);
    });

    it("filters by group", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function ExtractItems(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
        },
        classification: {
          "main.baml": `function ClassifyIntent(text: string) -> Intent {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      const list = registry.list("extraction");
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe("ExtractItems");
    });

    it("returns empty array for unknown group", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function ExtractItems(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
        },
      });

      expect(registry.list("nonexistent")).toEqual([]);
    });
  });

  describe("files are preserved in entries", () => {
    it("includes all file contents in the function entry", () => {
      const registry = createRegistry({
        extraction: {
          "main.baml": `function Extract(text: string) -> Item[] {
            client PiClient
            prompt #"..."#
          }`,
          "types.baml": `class Item { name string }`,
        },
      });

      const entry = registry.resolve("Extract");
      expect(Object.keys(entry.files)).toEqual(["main.baml", "types.baml"]);
    });
  });
});

describe("description from README.md", () => {
  it("populates description from README frontmatter", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
        "README.md": "---\ndescription: Extract structured items from text\n---\n\n# Extraction\n...",
      },
    });
    const entry = registry.resolve("Extract");
    expect(entry.description).toBe("Extract structured items from text");
  });

  it("description is undefined when no README.md", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
      },
    });
    const entry = registry.resolve("Extract");
    expect(entry.description).toBeUndefined();
  });

  it("filters README.md from entry files", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
        "README.md": "---\ndescription: test\n---\nbody",
      },
    });
    const entry = registry.resolve("Extract");
    expect(entry.files["README.md"]).toBeUndefined();
    expect(entry.files["main.baml"]).toBeDefined();
  });
});

describe("listGroups", () => {
  it("returns all groups with descriptions and function names", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
        "README.md": "---\ndescription: Extract items\n---",
      },
      classification: {
        "main.baml": `function Classify(text: string) -> Category { client PiClient prompt #"..."# }`,
      },
    });
    const groups = registry.listGroups();
    expect(groups).toHaveLength(2);

    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    expect(sorted[0]).toEqual({ name: "classification", functions: ["Classify"] });
    expect(sorted[1]).toEqual({ name: "extraction", description: "Extract items", functions: ["Extract"] });
  });

  it("sorts groups alphabetically", () => {
    const registry = FunctionsRegistry.fromGroups({
      zebra: { "main.baml": `function Z(x: string) -> string { client PiClient prompt #""# }` },
      alpha: { "main.baml": `function A(x: string) -> string { client PiClient prompt #""# }` },
    });
    const groups = registry.listGroups();
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[1]!.name).toBe("zebra");
  });

  it("returns empty array for empty registry", () => {
    const registry = FunctionsRegistry.fromGroups({});
    expect(registry.listGroups()).toEqual([]);
  });
});

describe("describeGroup", () => {
  it("returns full detail with readme body and types", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "types.baml": `class Item {\n  name string\n  priority "high" | "low"\n}`,
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
        "README.md": "---\ndescription: Extract items\n---\n\n# Extraction Group\n\nUse Extract to pull items.",
      },
    });
    const detail = registry.describeGroup("extraction");
    expect(detail).toBeDefined();
    expect(detail!.group).toBe("extraction");
    expect(detail!.description).toBe("Extract items");
    expect(detail!.readme).toContain("# Extraction Group");
    expect(detail!.types.length).toBeGreaterThan(0);
    expect(detail!.types[0]).toContain("class Item");
    expect(detail!.functions).toHaveLength(1);
    expect(detail!.functions[0]!.name).toBe("Extract");
    expect(detail!.functions[0]!.qualifiedName).toBe("extraction/Extract");
  });

  it("returns undefined for nonexistent group", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: { "main.baml": `function X(x: string) -> string { client PiClient prompt #""# }` },
    });
    expect(registry.describeGroup("nonexistent")).toBeUndefined();
  });

  it("works without README.md (no description, no readme body)", () => {
    const registry = FunctionsRegistry.fromGroups({
      extraction: {
        "types.baml": `class Item { name string }`,
        "main.baml": `function Extract(text: string) -> Item[] { client PiClient prompt #"..."# }`,
      },
    });
    const detail = registry.describeGroup("extraction");
    expect(detail!.description).toBeUndefined();
    expect(detail!.readme).toBeUndefined();
    expect(detail!.types.length).toBeGreaterThan(0);
  });
});

describe("mergeGroups", () => {
  it("adds new groups to an existing registry", () => {
    const registry = FunctionsRegistry.fromGroups({
      existing: {
        "main.baml": `function ExistingFunc(x: string) -> string { client PiClient prompt #""# }`,
      },
    });

    registry.mergeGroups({
      "skill:diagnose": {
        "main.baml": `function ClassifyBug(desc: string) -> string { client PiClient prompt #""# }`,
      },
    });

    expect(registry.list()).toHaveLength(2);
    expect(registry.resolve("ClassifyBug").group).toBe("skill:diagnose");
  });

  it("does not override existing groups with the same name", () => {
    const registry = FunctionsRegistry.fromGroups({
      "skill:diagnose": {
        "main.baml": `function Original(x: string) -> string { client PiClient prompt #""# }`,
      },
    });

    registry.mergeGroups({
      "skill:diagnose": {
        "main.baml": `function Replacement(x: string) -> string { client PiClient prompt #""# }`,
      },
    });

    // Original stays, Replacement is NOT added
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.name).toBe("Original");
  });

  it("registers description from README.md in merged group", () => {
    const registry = FunctionsRegistry.fromGroups({});

    registry.mergeGroups({
      "skill:extract": {
        "main.baml": `function Extract(x: string) -> string { client PiClient prompt #""# }`,
        "README.md": "---\ndescription: Extract structured data\n---\n\nBody text.",
      },
    });

    const groups = registry.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.description).toBe("Extract structured data");
  });

  it("handles empty merge gracefully", () => {
    const registry = FunctionsRegistry.fromGroups({
      existing: {
        "main.baml": `function Func(x: string) -> string { client PiClient prompt #""# }`,
      },
    });

    registry.mergeGroups({});
    expect(registry.list()).toHaveLength(1);
  });
});
