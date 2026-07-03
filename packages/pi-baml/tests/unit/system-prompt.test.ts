import { describe, it, expect } from "vitest";
import { renderBamlSystemPrompt } from "../../src/lib/system-prompt.js";
import { FunctionsRegistry } from "../../src/lib/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bamlFn(name: string, input = "x: string", output = "string"): string {
  return `function ${name}(${input}) -> ${output} { client PiClient prompt #""# }`;
}

function readme(description: string): string {
  return `---\ndescription: ${description}\n---\n`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("renderBamlSystemPrompt", () => {
  it("returns null for empty registry", () => {
    const registry = FunctionsRegistry.fromGroups({});
    expect(renderBamlSystemPrompt(registry)).toBeNull();
  });

  it("returns null when registry only has skill: groups", () => {
    const registry = FunctionsRegistry.fromGroups({
      "skill:diagnose": {
        "main.baml": bamlFn("Classify"),
        "README.md": readme("Diagnosis tools"),
      },
    });
    expect(renderBamlSystemPrompt(registry)).toBeNull();
  });

  it("returns valid XML block for populated registry", () => {
    const registry = FunctionsRegistry.fromGroups({
      "extract-todos": {
        "main.baml": bamlFn("ExtractTodos", "notes: string", "string[]"),
        "README.md": readme("Extract TODO items from text"),
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toBeNull();
    expect(result).toContain("<available_baml_functions>");
    expect(result).toContain("</available_baml_functions>");
    expect(result).toContain("<name>extract-todos</name>");
    expect(result).toContain("<description>Extract TODO items from text</description>");
  });

  it("excludes skill: prefixed groups from output", () => {
    const registry = FunctionsRegistry.fromGroups({
      "skill:diagnose": {
        "main.baml": bamlFn("Classify"),
        "README.md": readme("Diagnosis tools"),
      },
      "extract-todos": {
        "main.baml": bamlFn("ExtractTodos", "notes: string", "string[]"),
        "README.md": readme("Extract TODO items from text"),
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toContain("skill:diagnose");
    expect(result).toContain("extract-todos");
  });

  it("omits <description> element when group has no description", () => {
    const registry = FunctionsRegistry.fromGroups({
      "code-metrics": {
        "main.baml": bamlFn("CountLines", "code: string", "int"),
        // No README.md — no description
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toBeNull();
    expect(result).toContain("<name>code-metrics</name>");
    expect(result).not.toContain("<description>");
  });

  it("sorts groups alphabetically by name", () => {
    const registry = FunctionsRegistry.fromGroups({
      "zebra-group": {
        "main.baml": bamlFn("ZebraFunc"),
      },
      "alpha-group": {
        "main.baml": bamlFn("AlphaFunc"),
      },
      "middle-group": {
        "main.baml": bamlFn("MiddleFunc"),
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toBeNull();
    const alphaPos = result!.indexOf("alpha-group");
    const middlePos = result!.indexOf("middle-group");
    const zebraPos = result!.indexOf("zebra-group");
    expect(alphaPos).toBeLessThan(middlePos);
    expect(middlePos).toBeLessThan(zebraPos);
  });

  it("preamble references baml_run, baml_list, baml_exec, and baml skill", () => {
    const registry = FunctionsRegistry.fromGroups({
      "extract-todos": {
        "main.baml": bamlFn("ExtractTodos"),
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toBeNull();
    expect(result).toContain("baml_run");
    expect(result).toContain("baml_list");
    expect(result).toContain("baml_exec");
    expect(result).toContain("baml skill");
  });

  it("produces correct XML structure for mixed groups", () => {
    const registry = FunctionsRegistry.fromGroups({
      "skill:internal": {
        "main.baml": bamlFn("InternalFn"),
      },
      "extract-todos": {
        "main.baml": bamlFn("ExtractTodos", "notes: string", "string[]"),
        "README.md": readme("Extract TODO items from freeform text."),
      },
      "code-metrics": {
        "main.baml": bamlFn("CountLines", "code: string", "int"),
        // No description
      },
    });
    const result = renderBamlSystemPrompt(registry);
    expect(result).not.toBeNull();

    // code-metrics before extract-todos (alphabetical)
    const codePos = result!.indexOf("code-metrics");
    const extractPos = result!.indexOf("extract-todos");
    expect(codePos).toBeLessThan(extractPos);

    // code-metrics: name only, no description
    expect(result).toContain("    <name>code-metrics</name>");
    // No trailing empty description
    expect(result).not.toMatch(/<description>\s*<\/description>/);

    // extract-todos: name + description
    expect(result).toContain("    <name>extract-todos</name>");
    expect(result).toContain("    <description>Extract TODO items from freeform text.</description>");

    // skill: group excluded
    expect(result).not.toContain("skill:internal");
  });
});
