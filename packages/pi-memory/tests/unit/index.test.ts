import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import piMemory from "../../src/index.js";
import { MemoryStore } from "../../src/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness(options?: {
  pinned?: { key: string; value: string };
  lesson?: { rule: string; category: string };
}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-memory-extension-"));
  tempDirs.push(cwd);
  const memoryDir = join(cwd, "memory");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-memory": { localPath: memoryDir },
      memory: { dream: { enabled: false } },
    }),
  );
  if (options?.pinned || options?.lesson) {
    const store = new MemoryStore(join(memoryDir, "memory.db"));
    if (options.pinned) {
      store.setSemantic(options.pinned.key, options.pinned.value, 1, "user");
      store.pin(options.pinned.key);
    }
    if (options.lesson) {
      store.addLesson(options.lesson.rule, options.lesson.category, "user", false);
    }
    store.close();
  }

  const listeners = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),
    events: { emit: vi.fn() },
    on: (name: string, handler: (event: any, ctx: any) => any) => {
      listeners.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  piMemory(pi);
  return {
    ctx,
    tools,
    toolNames: [...tools.keys()],
    start: () => listeners.get("session_start")?.({ reason: "startup" }, ctx),
    shutdown: () => listeners.get("session_shutdown")?.({}, ctx),
    applyPrompt: async (sections: Record<string, string>) => {
      const systemPromptOptions = { sections };
      const result = await listeners.get("before_agent_start")?.(
        { systemPrompt: "stable prefix", systemPromptOptions },
        ctx,
      );
      return { result, sections: systemPromptOptions.sections };
    },
  };
}

describe("pi-memory extension surface", () => {
  it("keeps every existing memory tool registered", () => {
    const h = harness();

    expect(h.toolNames).toEqual([
      "memory_search",
      "memory_remember",
      "memory_forget",
      "memory_lessons",
      "memory_stats",
      "memory_pin",
    ]);
  });

  it("updates only the named memory section and leaves stable sections unchanged", async () => {
    const h = harness({ pinned: { key: "pref.editor", value: "Use the configured editor" } });
    await h.start();

    const first = await h.applyPrompt({ rules: "stable", memory: "stale" });
    const second = await h.applyPrompt({ ...first.sections });
    const changed = harness({ pinned: { key: "pref.editor", value: "Use Neovim" } });
    await changed.start();
    const third = await changed.applyPrompt({ ...first.sections });

    expect(first.result).toBeUndefined();
    expect(first.sections).toEqual({
      rules: "stable",
      memory: expect.stringContaining("pref.editor: Use the configured editor"),
    });
    expect(second.result).toBeUndefined();
    expect(second.sections).toEqual(first.sections);
    expect(third.sections.rules).toBe(first.sections.rules);
    expect(third.sections.memory).toContain("pref.editor: Use Neovim");
    expect(third.sections.memory).not.toBe(first.sections.memory);
    await h.shutdown();
    await changed.shutdown();
  });

  it("returns schema-valid structured data from every memory query tool", async () => {
    const h = harness({
      pinned: { key: "pref.editor", value: "x".repeat(5_000) },
      lesson: { rule: "Run focused tests first", category: "testing" },
    });
    await h.start();

    for (const [name, params] of [
      ["memory_search", { query: "editor", limit: 10 }],
      ["memory_lessons", { category: "testing", limit: 10 }],
      ["memory_stats", {}],
    ] as const) {
      const tool = h.tools.get(name)!;
      const result = await tool.execute("call", params, undefined, undefined, h.ctx as never);
      expect(tool.outputSchema).toBeDefined();
      expect(result.structuredContent).toBeDefined();
      expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
    }

    expect((await h.tools.get("memory_search")!.execute(
      "call",
      { query: "editor", limit: 10 },
      undefined,
      undefined,
      h.ctx as never,
    )).structuredContent).toMatchObject({ truncated: true });
    await h.shutdown();
  });

  it("serializes every memory tool and labels queries separately from mutations", () => {
    const h = harness();

    for (const name of ["memory_search", "memory_lessons", "memory_stats"]) {
      expect(h.tools.get(name)).toMatchObject({
        exposure: "direct",
        executionMode: "sequential",
        constrainedSampling: { type: "json_schema", strict: "prefer" },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      });
    }
    for (const name of ["memory_remember", "memory_forget", "memory_pin"]) {
      expect(h.tools.get(name)).toMatchObject({
        exposure: "direct",
        executionMode: "sequential",
        constrainedSampling: { type: "json_schema", strict: "prefer" },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      });
    }
  });

  it("removes a stale memory section when there are no pinned memories", async () => {
    const h = harness();
    await h.start();

    const result = await h.applyPrompt({ rules: "stable", memory: "stale" });

    expect(result.result).toBeUndefined();
    expect(result.sections).toEqual({ rules: "stable" });
    await h.shutdown();
  });
});
