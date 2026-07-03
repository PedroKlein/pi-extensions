import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BamlRuntime } from "@boundaryml/baml";

const EXAMPLES_DIR = join(import.meta.dirname, "../../examples");

/** Synthetic PiClient block for compilation. */
const SYNTHETIC_CLIENT = `client PiClient {
  provider anthropic
  options {
    model "placeholder"
    api_key "placeholder"
  }
}
`;

describe("example .baml files compilation", () => {
  const groups = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it.each(groups)("compiles %s without error", (group) => {
    const groupDir = join(EXAMPLES_DIR, group);
    const files: Record<string, string> = {};

    const bamlFiles = readdirSync(groupDir).filter((f) => f.endsWith(".baml"));
    for (const file of bamlFiles) {
      files[file] = readFileSync(join(groupDir, file), "utf-8");
    }

    expect(Object.keys(files).length).toBeGreaterThan(0);

    // This should not throw — compilation succeeds (with synthetic PiClient)
    const runtime = BamlRuntime.fromFiles("/", { ...files, "__pi_client.baml": SYNTHETIC_CLIENT }, {});
    expect(runtime).toBeDefined();
  });
});

describe("registry discovers example functions", () => {
  it("finds functions in classify-intent", () => {
    const files: Record<string, string> = {
      "main.baml": readFileSync(
        join(EXAMPLES_DIR, "classify-intent/main.baml"),
        "utf-8",
      ),
      "__pi_client.baml": SYNTHETIC_CLIENT,
    };

    const runtime = BamlRuntime.fromFiles("/", files, {});
    expect(runtime).toBeDefined();
  });

  it("finds functions in extract-structured", () => {
    const files: Record<string, string> = {
      "main.baml": readFileSync(
        join(EXAMPLES_DIR, "extract-structured/main.baml"),
        "utf-8",
      ),
      "__pi_client.baml": SYNTHETIC_CLIENT,
    };

    const runtime = BamlRuntime.fromFiles("/", files, {});
    expect(runtime).toBeDefined();
  });
});
