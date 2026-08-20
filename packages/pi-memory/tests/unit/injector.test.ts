import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDeterministicBlock } from "../../src/injector.js";
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
      { _always: [] },
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
      { _always: [] },
      { onBudgetExceeded: warning },
    );
    const second = buildDeterministicBlock(
      store,
      "/workspace/alpha",
      { _always: [] },
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
