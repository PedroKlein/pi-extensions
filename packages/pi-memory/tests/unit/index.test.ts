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
  facts?: Array<{ key: string; value: string }>;
  cwd?: string;
}) {
  const cwd = options?.cwd ?? mkdtempSync(join(tmpdir(), "pi-memory-extension-"));
  tempDirs.push(cwd);
  const memoryDir = join(cwd, "memory");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-memory": { localPath: memoryDir },
    }),
  );
  if (options?.pinned || options?.facts?.length) {
    const store = new MemoryStore(join(memoryDir, "memory.db"));
    if (options.pinned) {
      store.setSemantic(options.pinned.key, options.pinned.value, 1, "user");
      store.pin(options.pinned.key);
    }
    for (const fact of options.facts ?? []) {
      store.setSemantic(fact.key, fact.value, 1, "user");
    }
    store.close();
  }

  const listeners = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, ToolDefinition>();
  const registerCommand = vi.fn();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand,
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
    registerCommand,
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
      "memory_stats",
      "memory_pin",
    ]);
    expect(h.registerCommand).not.toHaveBeenCalled();
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
    });
    await h.start();

    for (const [name, params] of [
      ["memory_search", { query: "editor", limit: 10 }],
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

  it("scopes search and listing to global plus the current managed worktree by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-worktree-"));
    tempDirs.push(root);
    const repo = join(root, "alpha");
    const cwd = join(repo, "main");
    mkdirSync(join(repo, ".bare"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });

    const h = harness({
      cwd,
      facts: [
        { key: "pref.editor", value: "shared editor" },
        { key: "project.alpha.editor", value: "alpha editor" },
        { key: "project.beta.editor", value: "beta editor" },
      ],
    });
    await h.start();

    const search = await h.tools.get("memory_search")!.execute(
      "call",
      { query: "editor", limit: 10 },
      undefined,
      undefined,
      h.ctx as never,
    );
    expect(search.structuredContent).toMatchObject({
      scope: "current",
      project: "alpha",
      count: 2,
    });
    expect((search.structuredContent as any).results.map((result: any) => result.key)).toEqual([
      "pref.editor",
      "project.alpha.editor",
    ]);

    const listAll = await h.tools.get("memory_search")!.execute(
      "call",
      { scope: "all", limit: 2, offset: 0 },
      undefined,
      undefined,
      h.ctx as never,
    );
    expect(listAll.structuredContent).toMatchObject({
      scope: "all",
      offset: 0,
      count: 2,
      truncated: true,
      nextOffset: 2,
    });
    await h.shutdown();
  });

  it.each(["Foo_Bar", "Foo.Bar"])(
    "keeps writes, searches, pin lists, and injection consistent for the real %s repository",
    async (name) => {
      const root = mkdtempSync(join(tmpdir(), "pi-memory-project-scope-"));
      tempDirs.push(root);
      const repo = join(root, name);
      const cwd = join(repo, "src", "nested");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      // The harness always writes a temporary localPath override before startup.
      const h = harness({ cwd });
      const call = (tool: string, params: any) => h.tools.get(tool)!.execute(
        "call", params, undefined, undefined, h.ctx as never,
      );
      const slug = name.toLowerCase();
      const ownKey = `project.${slug}.editor`;
      const visibleKeys = ["pref.editor", ownKey];
      const otherKeys = ["foo", "foobar", "fooxbar", "foo_barista", "foo.barista", "other",
        slug === "foo_bar" ? "foo.bar" : "foo_bar"]
        .map((other) => `project.${other}.editor`);

      try {
        await h.start();
        expect(h.ctx.ui.notify).not.toHaveBeenCalled();
        const stats = await call("memory_stats", {});
        expect(stats.structuredContent).toMatchObject({
          dbPath: join(cwd, "memory", "memory.db"), semantic: 0,
        });
        // Seed pins from other repositories into the same temporary SQLite DB.
        const seed = new MemoryStore(join(cwd, "memory", "memory.db"));
        try {
          for (const key of otherKeys) {
            seed.setSemantic(key, "other editor");
            seed.pin(key);
          }
        } finally {
          seed.close();
        }
        await call("memory_remember", { key: "Pref.Editor", value: "shared editor", pinned: true });
        await call("memory_remember", {
          key: ownKey.toUpperCase(), value: "current editor", pinned: true,
        });

        for (const query of [undefined, "EDITOR"]) {
          for (const scope of [undefined, "current"]) {
            const result = await call("memory_search", { query, scope });
            expect(result.structuredContent).toMatchObject({
              project: slug, scope: "current", count: 2, total: 2, nextOffset: null, truncated: false,
            });
            expect((result.structuredContent as any).results.map((fact: any) => fact.key))
              .toEqual(visibleKeys);
            for (let offset = 0; offset <= 2; offset += 1) {
              const page = await call("memory_search", { query, scope, limit: 1, offset });
              expect(page.structuredContent).toMatchObject({
                total: 2, offset, count: offset < 2 ? 1 : 0,
                nextOffset: offset === 0 ? 1 : null, truncated: offset === 0,
              });
              expect((page.structuredContent as any).results.map((fact: any) => fact.key))
                .toEqual(visibleKeys.slice(offset, offset + 1));
            }
          }
        }
        const global = await call("memory_search", { scope: "global" });
        expect((global.structuredContent as any).results.map((fact: any) => fact.key))
          .toEqual(["pref.editor"]);
        const allKeys = [...visibleKeys, ...otherKeys].sort((a, b) => a.localeCompare(b));
        const all = await call("memory_search", { scope: "all", limit: 100 });
        expect((all.structuredContent as any).results.map((fact: any) => fact.key)).toEqual(allKeys);

        const pins = await call("memory_pin", { action: "list" });
        expect(pins.content).toEqual([{ type: "text", text:
          `📌 pref.editor: shared editor\n📌 ${ownKey}: current editor`,
        }]);
        const prompt = await h.applyPrompt({ rules: "stable" });
        expect(prompt.sections).toEqual({ rules: "stable", memory:
          `## Pinned Preferences\n- pref.editor: shared editor\n- ${ownKey}: current editor`,
        });
        expect((await h.applyPrompt({ ...prompt.sections })).sections).toEqual(prompt.sections);

        for (const key of otherKeys) {
          for (const [tool, params] of [
            ["memory_remember", { key, value: "wrong editor", pinned: true }],
            ["memory_forget", { key }],
            ["memory_pin", { action: "pin", key }],
            ["memory_pin", { action: "unpin", key }],
          ] as const) {
            await expect(call(tool, params)).rejects.toThrow("current repository slug");
          }
        }
        expect((await call("memory_search", { scope: "all", limit: 100 })).structuredContent)
          .toEqual(all.structuredContent);
        expect((await call("memory_pin", { action: "list" })).content).toEqual(pins.content);
        expect((await h.applyPrompt({ rules: "stable" })).sections).toEqual(prompt.sections);

        await call("memory_pin", { action: "unpin", key: ownKey.toUpperCase() });
        expect((await h.applyPrompt({})).sections.memory).toBe(
          "## Pinned Preferences\n- pref.editor: shared editor",
        );
        await call("memory_pin", { action: "pin", key: ownKey.toUpperCase() });
        expect((await h.applyPrompt({ rules: "stable" })).sections).toEqual(prompt.sections);
        await call("memory_forget", { key: ownKey.toUpperCase() });
        const afterDelete = await call("memory_search", {});
        expect((afterDelete.structuredContent as any).results.map((fact: any) => fact.key))
          .toEqual(["pref.editor"]);
        expect((await h.applyPrompt({})).sections.memory).not.toContain(ownKey);
      } finally {
        await h.shutdown();
      }
    },
  );

  it("rejects credential-shaped facts without echoing or persisting the value", async () => {
    const h = harness();
    await h.start();
    const secret = "tvly-abcdefghijklmnopqrstuvwxyz123456";

    await expect(h.tools.get("memory_remember")!.execute(
      "call",
      { key: "pref.secret", value: secret },
      undefined,
      undefined,
      h.ctx as never,
    )).rejects.toThrow("credential");

    const search = await h.tools.get("memory_search")!.execute(
      "call",
      { query: "secret", scope: "all" },
      undefined,
      undefined,
      h.ctx as never,
    );
    expect(search.content).not.toContain(secret);
    expect(search.structuredContent).toMatchObject({ count: 0 });
    await h.shutdown();
  });

  it("rejects project facts for a different repository", async () => {
    const h = harness();
    await h.start();

    await expect(h.tools.get("memory_remember")!.execute(
      "call",
      { key: "project.other.workflow", value: "wrong scope" },
      undefined,
      undefined,
      h.ctx as never,
    )).rejects.toThrow("current repository slug");
    await expect(h.tools.get("memory_forget")!.execute(
      "call",
      { key: "project.other.workflow" },
      undefined,
      undefined,
      h.ctx as never,
    )).rejects.toThrow("current repository slug");
    await expect(h.tools.get("memory_pin")!.execute(
      "call",
      { action: "pin", key: "project.other.workflow" },
      undefined,
      undefined,
      h.ctx as never,
    )).rejects.toThrow("current repository slug");
    await h.shutdown();
  });

  it("refreshes pinned context after mutations in the same session", async () => {
    const h = harness();
    await h.start();

    await h.tools.get("memory_remember")!.execute(
      "call",
      { key: "pref.editor", value: "Use Neovim", pinned: true },
      undefined,
      undefined,
      h.ctx as never,
    );
    const withPin = await h.applyPrompt({ rules: "stable" });
    expect(withPin.sections.memory).toContain("pref.editor: Use Neovim");

    await h.tools.get("memory_pin")!.execute(
      "call",
      { action: "unpin", key: "pref.editor" },
      undefined,
      undefined,
      h.ctx as never,
    );
    const withoutPin = await h.applyPrompt({ ...withPin.sections });
    expect(withoutPin.sections).toEqual({ rules: "stable" });
    await h.shutdown();
  });

  it("serializes every memory tool and labels queries separately from mutations", () => {
    const h = harness();

    for (const name of ["memory_search", "memory_stats"]) {
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
