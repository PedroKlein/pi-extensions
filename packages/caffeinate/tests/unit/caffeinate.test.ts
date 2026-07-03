import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to build minimal mocks
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
    ui: {
      setStatus: vi.fn(),
      theme: {
        fg: vi.fn((_color: string, text: string) => text),
      },
    },
  };
}

function makePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
  const emitted: Array<{ name: string; payload: unknown }> = [];

  return {
    on: vi.fn((event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) => {
      handlers[event] = handler;
    }),
    events: {
      emit: vi.fn((name: string, payload: unknown) => {
        emitted.push({ name, payload });
      }),
    },
    _handlers: handlers,
    _emitted: emitted,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-caffeinate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("registers agent_start, agent_end, and session_shutdown handlers", async () => {
    const pi = makePi();

    const { default: register } = await import("../../src/index.js");
    register(pi as any);

    expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("spawns caffeinate with correct args on macOS agent_start", async () => {
    // Mock platform to return darwin
    vi.doMock("node:os", () => ({ platform: () => "darwin" }));

    const mockProcess = {
      pid: undefined as unknown,
      on: vi.fn(),
      kill: vi.fn(),
    };
    const spawnMock = vi.fn().mockReturnValue(mockProcess);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);

    expect(spawnMock).toHaveBeenCalledWith(
      "caffeinate",
      ["-i", "-w", expect.any(String)],
      { stdio: "ignore" },
    );
  });

  it("spawns systemd-inhibit with correct args on Linux agent_start", async () => {
    vi.doMock("node:os", () => ({ platform: () => "linux" }));

    const mockProcess = { on: vi.fn(), kill: vi.fn() };
    const spawnMock = vi.fn().mockReturnValue(mockProcess);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);

    expect(spawnMock).toHaveBeenCalledWith(
      "systemd-inhibit",
      ["--what=idle", "--who=pi", "--why=Pi agent active", "sleep", "infinity"],
      { stdio: "ignore" },
    );
  });

  it("does nothing on unsupported platforms", async () => {
    vi.doMock("node:os", () => ({ platform: () => "win32" }));

    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills inhibitor on agent_end", async () => {
    vi.doMock("node:os", () => ({ platform: () => "darwin" }));

    const mockProcess = { on: vi.fn(), kill: vi.fn() };
    vi.doMock("node:child_process", () => ({ spawn: vi.fn().mockReturnValue(mockProcess) }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);
    await pi._handlers["agent_end"]!({}, ctx);

    expect(mockProcess.kill).toHaveBeenCalledOnce();
  });

  it("kills inhibitor on session_shutdown", async () => {
    vi.doMock("node:os", () => ({ platform: () => "darwin" }));

    const mockProcess = { on: vi.fn(), kill: vi.fn() };
    vi.doMock("node:child_process", () => ({ spawn: vi.fn().mockReturnValue(mockProcess) }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);
    await pi._handlers["session_shutdown"]!({}, ctx);

    expect(mockProcess.kill).toHaveBeenCalledOnce();
  });

  it("does not spawn a second inhibitor if one is already running", async () => {
    vi.doMock("node:os", () => ({ platform: () => "darwin" }));

    const mockProcess = { on: vi.fn(), kill: vi.fn() };
    const spawnMock = vi.fn().mockReturnValue(mockProcess);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { default: register } = await import("../../src/index.js");
    const pi = makePi();
    register(pi as any);

    const ctx = makeCtx();
    await pi._handlers["agent_start"]!({}, ctx);
    await pi._handlers["agent_start"]!({}, ctx); // second call — should be no-op

    expect(spawnMock).toHaveBeenCalledOnce();
  });
});
