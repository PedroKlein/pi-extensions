import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import piMemory from "../../src/index.js";
import { MemoryStore } from "../../src/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session consolidation", () => {
  it("uses the session model runtime, persists extracted memory, and reports routed usage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-memory-consolidation-"));
    tempDirs.push(cwd);
    const memoryDir = join(cwd, "memory");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      "pi-memory": { localPath: memoryDir },
      memory: {
        consolidationEnabled: true,
        consolidationModel: "router/auto",
        dream: { enabled: false },
      },
    }));

    const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
    const exec = vi.fn(() => {
      throw new Error("pi subprocesses must not be used for model work");
    });
    const emit = vi.fn();
    const selected = { provider: "router", id: "auto", name: "Auto", api: "test-api" };
    const response = {
      role: "assistant",
      content: [{
        type: "text",
        text: JSON.stringify({
          semantic: [{ key: "pref.editor", value: "Use Neovim", confidence: 0.95 }],
          lessons: [],
        }),
      }],
      api: "test-api",
      provider: "backend-a",
      model: "physical-model",
      usage: {
        input: 40,
        output: 10,
        cacheRead: 5,
        cacheWrite: 2,
        totalTokens: 57,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const streamSimple = vi.fn().mockReturnValue({ result: vi.fn().mockResolvedValue(response) });
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      exec,
      events: { emit },
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
        listeners.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    const branch = [
      "first request",
      "second request",
      "third request",
    ].map((content) => ({ type: "message", message: { role: "user", content } }));
    const ctx = {
      cwd,
      hasUI: false,
      signal: new AbortController().signal,
      model: selected,
      modelRegistry: { getAll: () => [selected], streamSimple } as unknown as ModelRegistry,
      sessionManager: { getBranch: () => branch },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as unknown as ExtensionContext;

    piMemory(pi);
    await listeners.get("session_start")?.({ reason: "startup" }, ctx);
    await listeners.get("session_shutdown")?.({}, ctx);

    expect(streamSimple).toHaveBeenCalledWith(
      selected,
      expect.objectContaining({
        messages: [expect.objectContaining({ role: "user", content: expect.any(Array) })],
      }),
      expect.objectContaining({ signal: ctx.signal, timeoutMs: 45_000 }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-memory",
        operation: "memory-consolidate",
        model: "router/auto",
        route: "backend-a/physical-model",
        input: 40,
        output: 10,
        cost: 0.03,
      }),
    );

    const store = new MemoryStore(join(memoryDir, "memory.db"));
    expect(store.getSemantic("pref.editor")?.value).toBe("Use Neovim");
    store.close();
  });

  it("aborts and observes an automatic Dream model call before closing the session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-memory-dream-shutdown-"));
    tempDirs.push(cwd);
    const memoryDir = join(cwd, "memory");
    const sessionsDir = join(cwd, "sessions", "--workspace-example--");
    mkdirSync(join(cwd, ".pi"));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      "pi-memory": { localPath: memoryDir },
      memory: {
        consolidationEnabled: false,
        dream: {
          enabled: true,
          autoTrigger: true,
          minHoursSinceDream: 0,
          minSessionsSinceDream: 1,
          sessionsDir: join(cwd, "sessions"),
          journalDir: join(cwd, "journal"),
          skillsDir: join(cwd, "skills"),
          minerModel: "router/auto",
          refinerModel: "router/auto",
          advisorModel: "router/auto",
        },
      },
    }));
    writeFileSync(
      join(sessionsDir, "2026-01-01T00-00-00-000Z_fixture.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "fixture" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "first substantive request" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "first answer" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "second substantive request" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "second answer" } }),
      ].join("\n"),
    );

    const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
    const selected = { provider: "router", id: "auto", name: "Auto", api: "test-api" };
    let observedSignal: AbortSignal | undefined;
    const streamSimple = vi.fn().mockImplementation((_model, _context, options) => ({
      result: async () => {
        observedSignal = options.signal;
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return {
          role: "assistant",
          content: [],
          api: "test-api",
          provider: "backend-a",
          model: "physical-model",
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          stopReason: "aborted",
          timestamp: Date.now(),
        };
      },
    }));
    const exec = vi.fn();
    const emit = vi.fn();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      exec,
      events: { emit },
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
        listeners.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      signal: undefined,
      model: selected,
      modelRegistry: { getAll: () => [selected], streamSimple } as unknown as ModelRegistry,
      sessionManager: { getBranch: () => [] },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as unknown as ExtensionContext;

    piMemory(pi);
    await listeners.get("session_start")?.({ reason: "startup" }, ctx);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await listeners.get("session_shutdown")?.({}, ctx);

    expect(observedSignal?.aborted).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        operation: "dream-mine",
        status: "error",
        cost: 0.01,
      }),
    );
  });
});
