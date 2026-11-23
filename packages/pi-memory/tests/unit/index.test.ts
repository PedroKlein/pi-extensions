import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import piMemory from "../../src/index.js";
import { MemoryStore } from "../../src/store.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: vi.fn(),
}));
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), realpathSync: vi.fn(actual.realpathSync) };
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness(options?: {
  pinned?: { key: string; value: string };
  facts?: Array<{ key: string; value: string }>;
  cwd?: string;
  agentDir?: string;
  trusted?: boolean;
  noOverride?: boolean;
}) {
  const cwd = options?.cwd ?? mkdtempSync(join(tmpdir(), "pi-memory-extension-"));
  tempDirs.push(cwd);
  const agentDir = options?.agentDir ?? join(cwd, "agent");
  const memoryDir = options?.noOverride ? join(agentDir, "memory") : join(cwd, "memory");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (!options?.noOverride) {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-memory": { localPath: memoryDir } }),
    );
  }
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
    isProjectTrusted: () => options?.trusted ?? true,
    hasUI: false,
    mode: "print",
    sessionManager: { getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  piMemory(pi);
  return {
    ctx,
    tools,
    registerCommand,
    toolNames: [...tools.keys()],
    start: () => {
      vi.mocked(getAgentDir).mockReturnValue(agentDir);
      return listeners.get("session_start")?.({ reason: "startup" }, ctx);
    },
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

describe("startup storage diagnostics", () => {
  it.each(["tui", "rpc", "print", "json"].flatMap((mode) =>
    ["legacy-global", "agent-local", "project-local"].map((storageMode) => [mode, storageMode]),
  ))("reports %s / %s on every successful empty-store start without stdout or prompt pollution", async (mode, storageMode) => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-diagnostic-"));
    tempDirs.push(root);
    const home = join(root, "fake-home");
    vi.mocked(homedir).mockReturnValue(home);
    const agentDir = storageMode === "legacy-global" ? join(home, ".pi", "agent") : join(home, "custom", "agent");
    const h = harness({ cwd: join(root, "cwd"), agentDir: `${agentDir}/../agent`, noOverride: true });
    h.ctx.mode = mode;
    h.ctx.hasUI = mode === "tui" || mode === "rpc";
    const dbPath = storageMode === "legacy-global"
      ? join(home, ".pi", "memory", "memory.db") : join(agentDir, "memory", "memory.db");
    if (storageMode === "project-local") {
      // Deliberately equal to the agent default: provenance, not path spelling, defines mode.
      writeFileSync(join(h.ctx.cwd, ".pi", "settings.json"), JSON.stringify({ "pi-memory": { localPath: join(agentDir, "memory") } }));
    }
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await h.start();
      await h.start();
      const expected = { type: "pi-memory-storage", agentDir, dbPath, storageMode };
      if (h.ctx.hasUI) {
        expect(h.ctx.ui.notify).toHaveBeenCalledTimes(2);
        for (const [message, level] of h.ctx.ui.notify.mock.calls) {
          expect(level).toBe("info");
          expect(JSON.parse(message)).toEqual(expected);
        }
        expect(stderr).not.toHaveBeenCalled();
      } else {
        expect(h.ctx.ui.notify).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledTimes(2);
        for (const [message] of stderr.mock.calls) expect(JSON.parse(String(message))).toEqual(expected);
      }
      expect(stdout).not.toHaveBeenCalled();
      const tool = h.tools.get("memory_stats")!;
      const result = await tool.execute("call", {}, undefined, undefined, h.ctx as never);
      expect(result.structuredContent).toEqual({ semantic: 0, events: 0, pinned: 0, agentDir, dbPath, storageMode });
      expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: `Memory: 0 facts (0 pinned), 0 events logged\nDB: ${dbPath}\nAgent Dir: ${agentDir}\nStorage mode: ${storageMode}` }]);
      expect((await h.applyPrompt({ rules: "unchanged" })).sections).toEqual({ rules: "unchanged" });
    } finally {
      await h.shutdown();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it.each(["print", "json"])("JSON-escapes newlines and control characters on %s stderr", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-control-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent\n\r\t\u001b-control");
    const h = harness({ cwd: join(root, "cwd"), agentDir, noOverride: true });
    h.ctx.mode = mode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await h.start();
      const message = String(stderr.mock.calls[0][0]);
      expect(message.split("\n")).toHaveLength(2);
      expect(message.slice(0, -1)).not.toMatch(/[\u0000-\u001f]/);
      expect(JSON.parse(message)).toEqual({ type: "pi-memory-storage", agentDir, dbPath: join(agentDir, "memory", "memory.db"), storageMode: "agent-local" });
      expect(stdout).not.toHaveBeenCalled();
    } finally { await h.shutdown(); }
  });

  it.each(["tui", "rpc", "print", "json"])("clears stale dir/mode on %s failure/shutdown and reports only the recovered selection", async (mode) => {
    const h = harness();
    h.ctx.mode = mode;
    h.ctx.hasUI = mode === "tui" || mode === "rpc";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await h.start();
      const settings = join(h.ctx.cwd, ".pi", "settings.json");
      writeFileSync(settings, "{ invalid sensitive-marker");
      h.ctx.ui.notify.mockClear();
      stderr.mockClear();
      if (h.ctx.hasUI) await h.start();
      else await expect(h.start()).rejects.toThrow("failed to initialize");
      expect(h.ctx.ui.notify.mock.calls.filter(([, level]) => level === "info")).toEqual([]);
      expect(stderr).not.toHaveBeenCalled();
      await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never)).rejects.toThrow("Memory store not initialized");
      expect((await h.applyPrompt({ memory: "stale" })).sections).toEqual({});
      await h.shutdown();
      await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never)).rejects.toThrow(/^Memory store not initialized$/);
      rmSync(settings);
      await h.start();
      const result = await h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never);
      expect(result.structuredContent).toMatchObject({ agentDir: join(h.ctx.cwd, "agent"), storageMode: "agent-local", dbPath: join(h.ctx.cwd, "agent", "memory", "memory.db") });
      const diagnostic = h.ctx.hasUI ? h.ctx.ui.notify.mock.calls.at(-1)![0] : String(stderr.mock.calls.at(-1)![0]);
      expect(JSON.parse(diagnostic)).toMatchObject({
        agentDir: (result.structuredContent as any).agentDir,
        dbPath: (result.structuredContent as any).dbPath,
        storageMode: "agent-local",
      });
    } finally { await h.shutdown(); }
  });
});

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

  it("isolates real temporary databases across agents, including writes and deletes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-agents-"));
    tempDirs.push(root);
    const agentA = join(root, "pico", "agent");
    const a = harness({ cwd: join(root, "project-a"), agentDir: agentA, noOverride: true });
    const b = harness({ cwd: join(root, "project-b"), agentDir: join(root, "eros", "agent"), noOverride: true });
    const sameAgent = harness({ cwd: join(root, "project-c"), agentDir: agentA, noOverride: true });
    await a.start();
    await b.start();
    await sameAgent.start();
    const run = (h: typeof a, name: string, params: any = {}) =>
      h.tools.get(name)!.execute("call", params, undefined, undefined, h.ctx as never);
    try {
      await run(a, "memory_remember", { key: "pref.editor", value: "Pico editor", pinned: true });
      expect((await run(b, "memory_search")).structuredContent).toMatchObject({ count: 0 });
      expect((await run(sameAgent, "memory_search")).structuredContent).toMatchObject({
        results: [expect.objectContaining({ value: "Pico editor" })],
      });
      await run(b, "memory_remember", { key: "pref.editor", value: "Eros editor", pinned: true });
      await run(a, "memory_forget", { key: "pref.editor" });
      expect((await run(a, "memory_search")).structuredContent).toMatchObject({ count: 0 });
      expect((await run(b, "memory_search")).structuredContent).toMatchObject({
        results: [expect.objectContaining({ value: "Eros editor" })],
      });
      expect((await b.applyPrompt({})).sections.memory).toContain("Eros editor");
      expect((await a.applyPrompt({})).sections.memory).toBeUndefined();
      expect((await run(a, "memory_stats")).structuredContent).toMatchObject({ dbPath: join(agentA, "memory", "memory.db") });
    } finally {
      await a.shutdown();
      await b.shutdown();
      await sameAgent.shutdown();
    }
  });

  it("ignores untrusted overrides and does not use globally merged settings", async () => {
    const h = harness({ trusted: false, pinned: { key: "pref.editor", value: "Project-only editor" } });
    await h.start();
    try {
      const stats = await h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never);
      expect(stats.structuredContent).toMatchObject({ semantic: 0, dbPath: join(h.ctx.cwd, "agent", "memory", "memory.db") });
      expect((await h.applyPrompt({})).sections.memory).toBeUndefined();
    } finally {
      await h.shutdown();
    }
  });

  it("closes the previous store before successful reinitialization and clears cache on shutdown", async () => {
    const h = harness({ pinned: { key: "pref.editor", value: "Previous editor" } });
    const close = vi.spyOn(MemoryStore.prototype, "close");
    await h.start();
    await h.start();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].stats()).toThrow();
    expect((await h.applyPrompt({})).sections.memory).toContain("Previous editor");
    await h.shutdown();
    expect(close).toHaveBeenCalledTimes(2);
    expect((await h.applyPrompt({ memory: "stale" })).sections.memory).toBeUndefined();
    await h.shutdown();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each(["config", "database"])("clears old store/cache on %s failure without fallback or stale path", async (failure) => {
    const h = harness({ pinned: { key: "pref.editor", value: "Old pinned editor" } });
    h.ctx.hasUI = true;
    const close = vi.spyOn(MemoryStore.prototype, "close");
    await h.start();
    expect((await h.applyPrompt({})).sections.memory).toContain("Old pinned editor");
    const settings = join(h.ctx.cwd, ".pi", "settings.json");
    const blocked = join(h.ctx.cwd, "blocked");
    if (failure === "config") {
      writeFileSync(settings, "{ sensitive-config-marker");
    } else {
      writeFileSync(blocked, "not a directory");
      writeFileSync(settings, JSON.stringify({ "pi-memory": { localPath: blocked } }));
    }
    await h.start();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].stats()).toThrow();
    for (const name of h.toolNames) {
      await expect(h.tools.get(name)!.execute("call", {}, undefined, undefined, h.ctx as never))
        .rejects.toThrow("Memory store not initialized");
    }
    expect((await h.applyPrompt({ rules: "stable", memory: "stale" })).sections).toEqual({ rules: "stable" });
    expect(existsSync(join(h.ctx.cwd, "agent", "memory"))).toBe(false);
    const notification = h.ctx.ui.notify.mock.calls.at(-1)!;
    expect(notification[1]).toBe("error");
    expect(notification[0]).toContain(failure === "config" ? settings : join(blocked, "memory.db"));
    expect(notification[0]).not.toContain("sensitive-config-marker");
    expect(notification[0]).not.toContain(join(h.ctx.cwd, "memory", "memory.db"));
    // A later resolution failure must not reuse the failed DB path either.
    writeFileSync(settings, "{ sensitive-config-marker");
    await h.start();
    expect(h.ctx.ui.notify.mock.calls.at(-1)![0]).not.toContain(blocked);
    expect(close).toHaveBeenCalledTimes(1);
    await h.shutdown();
  });

  it("closes a newly opened store when subsequent initialization fails", async () => {
    const h = harness();
    h.ctx.hasUI = true;
    const close = vi.spyOn(MemoryStore.prototype, "close");
    vi.spyOn(MemoryStore.prototype, "listPinned").mockImplementationOnce(() => {
      throw new Error("sensitive-initialization-message");
    });
    await h.start();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].stats()).toThrow();
    expect((await h.applyPrompt({ memory: "stale" })).sections).toEqual({});
    expect(h.ctx.ui.notify.mock.calls.at(-1)![0]).not.toContain("sensitive-initialization-message");
    await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never))
      .rejects.toThrow("Memory store not initialized");
    await h.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("clears state before reporting a previous-connection close failure", async () => {
    const h = harness({ pinned: { key: "pref.editor", value: "Old editor" } });
    await h.start();
    const close = MemoryStore.prototype.close;
    vi.spyOn(MemoryStore.prototype, "close").mockImplementationOnce(function () {
      close.call(this);
      throw Object.assign(new Error("sensitive-close-error"), { code: "EIO" });
    });
    const diagnostic = `${join(h.ctx.cwd, "memory", "memory.db")}: EIO`;
    await expect(h.start()).rejects.toThrow(diagnostic);
    expect((await h.applyPrompt({ memory: "stale" })).sections).toEqual({});
    await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never))
      .rejects.toThrow(diagnostic);
    await h.shutdown();
  });

  it.each([
    ["tui", "mkdir"], ["rpc", "pragma"], ["json", "migration"], ["print", "permission"],
    ["json", "canonical"], ["print", "open"], ["json", "config"],
  ])("reports %s initialization %s failures and retains the safe diagnostic in every tool", async (mode, stage) => {
    const h = harness({ pinned: { key: "pref.editor", value: "Old pinned editor" }, noOverride: true });
    h.ctx.hasUI = mode === "tui" || mode === "rpc";
    const close = vi.spyOn(MemoryStore.prototype, "close");
    await h.start();
    expect((await h.applyPrompt({})).sections.memory).toContain("Old pinned editor");
    h.ctx.ui.notify.mockClear();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dbPath = join(h.ctx.cwd, "agent", "memory", "memory.db");
    const settings = join(h.ctx.cwd, ".pi", "settings.json");
    let affectedPath = dbPath;
    let code = "ERR_SQLITE_ERROR";
    const failure = (code: string) => Object.assign(new Error("sensitive-initialization-marker"), { code });
    const dbClose = vi.spyOn(DatabaseSync.prototype, "close");
    if (stage === "mkdir" || stage === "permission") {
      code = stage === "mkdir" ? "ENOSPC" : "EACCES";
      vi.mocked(fs.mkdirSync).mockImplementationOnce(() => { throw failure(code); });
    } else if (stage === "canonical") {
      code = "EPERM";
      affectedPath = join(h.ctx.cwd, "agent");
      vi.mocked(fs.realpathSync).mockImplementationOnce(() => { throw failure(code); });
    } else if (stage === "config") {
      code = "SyntaxError";
      affectedPath = settings;
      writeFileSync(settings, "{ sensitive-initialization-marker");
    } else if (stage === "open") {
      const blocked = join(h.ctx.cwd, "blocked.db-directory");
      mkdirSync(join(blocked, "memory.db"), { recursive: true });
      writeFileSync(settings, JSON.stringify({ "pi-memory": { localPath: blocked } }));
      affectedPath = join(blocked, "memory.db");
    } else {
      if (stage === "migration") {
        // Remove pinned on the temporary DB to force a real ALTER on the next open.
        const db = new DatabaseSync(dbPath);
        db.exec("ALTER TABLE semantic DROP COLUMN pinned");
        db.close();
        dbClose.mockClear();
      }
      const exec = DatabaseSync.prototype.exec;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
        if (sql.includes(stage === "pragma" ? "PRAGMA journal_mode" : "ALTER TABLE")) throw failure(code);
        return exec.call(this, sql);
      });
    }
    const message = `pi-memory: failed to initialize: ${affectedPath}: ${code}`;
    if (h.ctx.hasUI) {
      await expect(h.start()).resolves.toBeUndefined();
      expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(message, "error");
    } else {
      h.ctx.ui.notify.mockClear();
      await expect(h.start()).rejects.toThrow(message);
      expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    }
    expect(h.ctx.ui.notify.mock.calls.filter(([, level]) => level === "info")).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => close.mock.contexts[0].stats()).toThrow();
    expect(dbClose).toHaveBeenCalledTimes(stage === "pragma" || stage === "migration" ? 2 : 1);
    for (const db of dbClose.mock.contexts) expect(() => db.prepare("SELECT 1")).toThrow();
    for (const name of h.toolNames) {
      await expect(h.tools.get(name)!.execute("call", {}, undefined, undefined, h.ctx as never))
        .rejects.toThrow(`Memory store not initialized: ${message}`);
    }
    expect((await h.applyPrompt({ rules: "stable", memory: "stale" })).sections).toEqual({ rules: "stable" });
    // Recover without carrying the initialization diagnostic into the next session.
    vi.restoreAllMocks();
    rmSync(settings, { force: true });
    await h.start();
    await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never)).resolves.toBeDefined();
    await h.shutdown();
    await expect(h.tools.get("memory_stats")!.execute("call", {}, undefined, undefined, h.ctx as never))
      .rejects.toThrow(/^Memory store not initialized$/);
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
