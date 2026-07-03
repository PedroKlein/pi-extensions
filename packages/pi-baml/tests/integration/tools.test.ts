import { describe, it, expect } from "vitest";
import { BamlRuntime } from "@boundaryml/baml";
import { FunctionsRegistry, parseFunctionDeclarations } from "../../src/lib/registry.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXAMPLES_DIR = join(import.meta.dirname, "../../examples");

/** Synthetic PiClient block to satisfy BAML compiler for files using client PiClient. */
const SYNTHETIC_CLIENT = `client PiClient {
  provider anthropic
  options {
    model "placeholder"
    api_key "placeholder"
  }
}
`;

describe("full tool integration", () => {
  it("registry discovers and parses real example files", () => {
    const groups: Record<string, Record<string, string>> = {};

    const dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of dirs) {
      const groupPath = join(EXAMPLES_DIR, dir.name);
      const files: Record<string, string> = {};

      for (const file of readdirSync(groupPath).filter((f) => f.endsWith(".baml"))) {
        files[file] = readFileSync(join(groupPath, file), "utf-8");
      }

      groups[dir.name] = files;
    }

    const registry = FunctionsRegistry.fromGroups(groups);
    const list = registry.list();

    expect(list.length).toBeGreaterThan(0);

    // Verify each function can be resolved
    for (const fn of list) {
      const entry = registry.resolve(fn.name);
      expect(entry.files).toBeDefined();
      expect(Object.keys(entry.files).length).toBeGreaterThan(0);
    }
  });

  it("registry functions compile via BamlRuntime", () => {
    const dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of dirs) {
      const groupPath = join(EXAMPLES_DIR, dir.name);
      const files: Record<string, string> = {};

      for (const file of readdirSync(groupPath).filter((f) => f.endsWith(".baml"))) {
        files[file] = readFileSync(join(groupPath, file), "utf-8");
      }

      // Should compile without error (with synthetic PiClient)
      const runtime = BamlRuntime.fromFiles("/", { ...files, "__pi_client.baml": SYNTHETIC_CLIENT }, {});
      expect(runtime).toBeDefined();
    }
  });

  it("function declarations match what BAML compiles", () => {
    const source = readFileSync(
      join(EXAMPLES_DIR, "classify-intent/main.baml"),
      "utf-8",
    );

    const declarations = parseFunctionDeclarations(source);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.name).toBe("ClassifyIntent");

    // Should also compile (with synthetic PiClient)
    const runtime = BamlRuntime.fromFiles("/", { "main.baml": source, "__pi_client.baml": SYNTHETIC_CLIENT }, {});
    expect(runtime).toBeDefined();
  });

  it("createBamlExecutor injects synthetic PiClient so compilation succeeds", async () => {
    const { createBamlExecutor } = await import("../../src/lib/executor.js");
    const { ClientRegistry } = await import("@boundaryml/baml");

    // This code references 'client PiClient' — would fail without synthetic injection
    const code = `
class Sentiment {
  label string
  score float
}

function Analyze(text: string) -> Sentiment {
  client PiClient
  prompt #"
    Analyze sentiment: {{ text }}
    {{ ctx.output_format }}
  "#
}
`;

    const cr = new ClientRegistry();
    cr.addLlmClient("PiClient", "anthropic", {
      model: "claude-4.5-haiku",
      api_key: "test-key",
      base_url: "http://localhost:9999",
    });
    cr.setPrimary("PiClient");

    // Should NOT throw — the synthetic PiClient block satisfies the compiler
    const executor = createBamlExecutor({
      files: { "dynamic.baml": code },
      clientRegistry: cr,
      syntheticProvider: "anthropic",
    });

    expect(executor).toBeDefined();
    expect(typeof executor.call).toBe("function");
    expect(typeof executor.dispose).toBe("function");
  });
});
