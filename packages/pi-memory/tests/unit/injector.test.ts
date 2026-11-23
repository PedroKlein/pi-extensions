import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDeterministicBlock, projectSlug } from "../../src/injector.js";
import { MemoryStore } from "../../src/store.js";

let tmpDir: string;
let store: MemoryStore;

function rememberPinned(key: string, value: string): void {
  store.setSemantic(key, value, 1, "user");
  store.pin(key);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-injector-"));
  store = new MemoryStore(join(tmpDir, "memory.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildDeterministicBlock", () => {
  it("includes global pins and only project pins matching the cwd", () => {
    rememberPinned("pref.editor", "Use the configured editor");
    rememberPinned("project.alpha.workflow", "Alpha-specific workflow");
    rememberPinned("project.beta.workflow", "Beta-specific workflow");

    const block = buildDeterministicBlock(
      store,
      "/workspace/alpha",
    );

    expect(block.factKeys).toEqual([
      "pref.editor",
      "project.alpha.workflow",
    ]);
    expect(block.text).toContain("pref.editor: Use the configured editor");
    expect(block.text).toContain(
      "project.alpha.workflow: Alpha-specific workflow",
    );
    expect(block.text).not.toContain("project.beta.workflow");
    expect(block.text).not.toMatch(/facts|lessons|memory_search|BEFORE starting/i);
  });

  it.each(["Foo.Bar", "Foo_Bar"])(
    "injects exact project pins for the real %s repository in stable budgeted order",
    (name) => {
      const repo = join(tmpDir, name);
      const cwd = join(repo, "src", "nested");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const slug = name.toLowerCase();
      const otherSlugs = ["foo", "foobar", "fooxbar", "foo.barista", "foo_barista", "other",
        slug === "foo.bar" ? "foo_bar" : "foo.bar"];
      for (const other of otherSlugs) {
        rememberPinned(`project.${other}.workflow`, "wrong project");
      }
      // The trailing dot is part of the prefix boundary.
      rememberPinned(`project.${slug}`, "not a fact beneath the project prefix");
      rememberPinned(`PROJECT.${name}.WORKFLOW`, "current workflow");
      rememberPinned("Pref.Editor", "global editor");
      const expected = ["pref.editor", `project.${slug}.workflow`];

      expect(projectSlug(cwd)).toBe(slug);
      const first = buildDeterministicBlock(store, cwd);
      expect(first.factKeys).toEqual(expected);
      expect(first.stats.facts).toBe(2);
      expect(first.budgetExceeded).toBe(false);
      expect(first.omittedFacts).toBe(0);
      expect(first.estimatedTokens).toBeLessThanOrEqual(500);
      expect(buildDeterministicBlock(store, cwd)).toEqual(first);

      store.unpin(`project.${slug}.workflow`);
      const globalOnly = buildDeterministicBlock(store, cwd);
      store.pin(`project.${slug}.workflow`);
      const warning = vi.fn();
      const limited = buildDeterministicBlock(store, cwd, {
        tokenBudget: globalOnly.estimatedTokens,
        onBudgetExceeded: warning,
      });
      expect(limited.factKeys).toEqual(["pref.editor"]);
      expect(limited.estimatedTokens).toBeLessThanOrEqual(globalOnly.estimatedTokens);
      expect(limited.budgetExceeded).toBe(true);
      expect(limited.omittedFacts).toBe(1);
      expect(warning).toHaveBeenCalledOnce();
    },
  );

  it("resolves the repository name for a managed main worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-worktree-"));
    const repo = join(root, "alpha");
    const cwd = join(repo, "main");
    mkdirSync(join(repo, ".bare"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });

    expect(projectSlug(cwd)).toBe("alpha");
    rmSync(root, { recursive: true, force: true });
  });

  it("caps at 500 tokens in stable key order and emits a visible warning", () => {
    for (let index = 0; index < 12; index += 1) {
      rememberPinned(
        `pref.long-${String(index).padStart(2, "0")}`,
        `value-${index} ${"context ".repeat(80)}`,
      );
    }
    const warning = vi.fn();

    const first = buildDeterministicBlock(
      store,
      "/workspace/alpha",
      { onBudgetExceeded: warning },
    );
    const second = buildDeterministicBlock(
      store,
      "/workspace/alpha",
      { onBudgetExceeded: vi.fn() },
    );

    expect(first.estimatedTokens).toBeLessThanOrEqual(500);
    expect(first.budgetExceeded).toBe(true);
    expect(first.omittedFacts).toBeGreaterThan(0);
    expect(first.factKeys).toEqual(second.factKeys);
    expect(first.factKeys).toEqual(
      store
        .listPinned()
        .slice(0, first.factKeys.length)
        .map((fact) => fact.key),
    );
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("500-token pinned-memory budget"),
    );
  });
});
