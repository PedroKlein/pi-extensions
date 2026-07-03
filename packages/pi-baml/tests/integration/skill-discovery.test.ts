import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BamlRuntime } from "@boundaryml/baml";
import { discoverBamlGroups } from "../../src/lib/discovery.js";
import { FunctionsRegistry } from "../../src/lib/registry.js";
import { renderBamlSystemPrompt } from "../../src/lib/system-prompt.js";

/** Synthetic PiClient block required for BAML compilation — real credentials injected at call time. */
const SYNTHETIC_CLIENT = `client PiClient {
  provider anthropic
  options {
    model "placeholder"
    api_key "placeholder"
  }
}
`;

function createTmpDir(): string {
  const dir = join(
    tmpdir(),
    `pi-baml-skill-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("skill BAML discovery integration", () => {
  let tmpRoot: string;
  let skillsDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = createTmpDir();
    skillsDir = join(tmpRoot, "skills");
    projectDir = join(tmpRoot, "project");
    mkdirSync(projectDir, { recursive: true });

    // Create skill: diagnose with baml/
    const diagnoseBaml = join(skillsDir, "diagnose", "baml");
    mkdirSync(diagnoseBaml, { recursive: true });

    writeFileSync(
      join(diagnoseBaml, "README.md"),
      [
        "---",
        "description: Diagnosis assistance — classify phases and suggest hypotheses",
        "---",
        "",
        "# Diagnose Functions",
        "",
        "Use ClassifyBugPhase to identify where you are in the debugging process.",
      ].join("\n"),
    );

    writeFileSync(
      join(diagnoseBaml, "types.baml"),
      [
        "class DiagnosisPhase {",
        '  phase "reproduce" | "minimize" | "hypothesize" | "instrument" | "fix"',
        '  confidence float @description("0.0 to 1.0")',
        "  reasoning string",
        "}",
      ].join("\n"),
    );

    writeFileSync(
      join(diagnoseBaml, "classify.baml"),
      [
        "function ClassifyBugPhase(symptoms: string, evidence: string) -> DiagnosisPhase {",
        "  client PiClient",
        '  prompt #"',
        "    Given these symptoms and evidence, classify the current diagnosis phase.",
        "    ",
        "    {{ ctx.output_format }}",
        "    ",
        "    Symptoms: {{ symptoms }}",
        "    Evidence: {{ evidence }}",
        '  "#',
        "}",
      ].join("\n"),
    );

    // Create a non-skill global group in the project's .agents/baml/
    const globalBaml = join(projectDir, ".agents", "baml", "extract-todos");
    mkdirSync(globalBaml, { recursive: true });
    writeFileSync(
      join(globalBaml, "README.md"),
      "---\ndescription: Extract TODO items\n---\n\n# TODOs",
    );
    writeFileSync(
      join(globalBaml, "main.baml"),
      [
        "class TodoItem {",
        "  task string",
        '  priority "high" | "medium" | "low"',
        "}",
        "",
        "function ExtractTodos(notes: string) -> TodoItem[] {",
        "  client PiClient",
        '  prompt #"{{ notes }} {{ ctx.output_format }}"#',
        "}",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("discovers skill group with skill: prefix", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    expect(groups["skill:diagnose"]).toBeDefined();
    expect(groups["extract-todos"]).toBeDefined();
  });

  it("skill BAML compiles without README.md contamination", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    const registry = FunctionsRegistry.fromGroups(groups);

    const entry = registry.resolve("skill:diagnose/ClassifyBugPhase");

    // entry.files must NOT contain README.md
    expect(entry.files["README.md"]).toBeUndefined();

    // Compile with BamlRuntime to prove no README.md contamination.
    // Synthetic PiClient is required — the function references it but it lives
    // in ClientRegistry at call time, not in the .baml source files.
    expect(() => {
      BamlRuntime.fromFiles(
        "/",
        { ...entry.files, "__pi_client.baml": SYNTHETIC_CLIENT },
        {},
      );
    }).not.toThrow();
  });

  it("registry has correct description from README frontmatter", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    const registry = FunctionsRegistry.fromGroups(groups);
    const entry = registry.resolve("skill:diagnose/ClassifyBugPhase");
    expect(entry.description).toBe(
      "Diagnosis assistance \u2014 classify phases and suggest hypotheses",
    );
  });

  it("listGroups includes both skill and global groups", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    const registry = FunctionsRegistry.fromGroups(groups);
    const groupList = registry.listGroups();
    const names = groupList.map((g) => g.name);
    expect(names).toContain("skill:diagnose");
    expect(names).toContain("extract-todos");
  });

  it("describeGroup returns full detail for skill group", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    const registry = FunctionsRegistry.fromGroups(groups);
    const detail = registry.describeGroup("skill:diagnose");

    expect(detail).toBeDefined();
    expect(detail!.group).toBe("skill:diagnose");
    expect(detail!.description).toBe(
      "Diagnosis assistance \u2014 classify phases and suggest hypotheses",
    );
    expect(detail!.readme).toContain("# Diagnose Functions");
    expect(detail!.types.length).toBeGreaterThan(0);
    expect(detail!.types.some((t) => t.includes("class DiagnosisPhase"))).toBe(
      true,
    );
    expect(detail!.functions).toHaveLength(1);
    expect(detail!.functions[0]!.qualifiedName).toBe(
      "skill:diagnose/ClassifyBugPhase",
    );
  });

  it("system prompt excludes skill groups but includes global groups", () => {
    const groups = discoverBamlGroups(projectDir, [], [skillsDir]);
    const registry = FunctionsRegistry.fromGroups(groups);
    const prompt = renderBamlSystemPrompt(registry);

    expect(prompt).not.toBeNull();
    expect(prompt).toContain("extract-todos");
    expect(prompt).not.toContain("skill:diagnose");
  });
});
