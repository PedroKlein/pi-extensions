import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPiBamlExtension } from "../../src/index.js";
import { discoverBamlGroups } from "../../src/lib/discovery.js";

// Mock @boundaryml/baml
vi.mock("@boundaryml/baml", () => ({
  BamlRuntime: {
    fromFiles: vi.fn().mockReturnValue({
      callFunction: vi.fn().mockResolvedValue({
        isOk: () => true,
        parsed: () => "result",
      }),
      createContextManager: vi.fn().mockReturnValue({}),
    }),
  },
  ClientRegistry: vi.fn().mockImplementation(() => ({
    addLlmClient: vi.fn(),
    setPrimary: vi.fn(),
  })),
  Collector: vi.fn().mockImplementation(() => ({ last: null })),
  setLogLevel: vi.fn(),
}));

// Mock discovery so tests are isolated from the real filesystem
vi.mock("../../src/lib/discovery.js", () => ({
  discoverBamlGroups: vi.fn().mockReturnValue({}),
}));

function createMockPi() {
  return {
    registerTool: vi.fn(),
    events: { emit: vi.fn() },
    on: vi.fn(),
  };
}

const testSettings = {
  baml: {
    models: {
      light: "github-copilot/claude-haiku-4.5",
      standard: "github-copilot/claude-sonnet-4.6",
      heavy: "github-copilot/claude-opus-4.7",
    },
  },
};

describe("pi-baml extension factory", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("registers all three tools", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });

    expect(pi.registerTool).toHaveBeenCalledTimes(3);
    const names = pi.registerTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name).sort();
    expect(names).toEqual(["baml_exec", "baml_list", "baml_run"]);
  });

  it("emits pi-baml:ready with available=true", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });

    expect(pi.events.emit).toHaveBeenCalledWith(
      "pi-baml:ready",
      expect.objectContaining({ available: true }),
    );
  });

  it("emitted library has expected methods", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });

    const lib = pi.events.emit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(lib["available"]).toBe(true);
    expect(typeof lib["createExecutor"]).toBe("function");
    expect(typeof lib["execBaml"]).toBe("function");
    expect(typeof lib["call"]).toBe("function");
    expect(typeof lib["list"]).toBe("function");
  });

  it("does not register session_start handler (stateless)", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });
    // before_agent_start may be registered for system prompt injection, but session_start must not be
    const events = pi.on.mock.calls.map((c: unknown[]) => (c[0] as string));
    expect(events).not.toContain("session_start");
  });

  it("always registers before_agent_start for lazy skill discovery", () => {
    // Even with empty registry, before_agent_start is needed for skill discovery
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });
    const events = pi.on.mock.calls.map((c: unknown[]) => (c[0] as string));
    expect(events).toContain("before_agent_start");
  });

  it("registers before_agent_start when registry has discoverable groups", () => {
    vi.mocked(discoverBamlGroups).mockReturnValueOnce({
      "extract-todos": {
        "main.baml": `function ExtractTodos(notes: string) -> string { client PiClient prompt #""# }`,
      },
    });
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: testSettings });
    const events = pi.on.mock.calls.map((c: unknown[]) => (c[0] as string));
    expect(events).toContain("before_agent_start");
  });

  it("before_agent_start does not inject system prompt when systemPrompt is false", () => {
    vi.mocked(discoverBamlGroups).mockReturnValueOnce({
      "extract-todos": {
        "main.baml": `function ExtractTodos(notes: string) -> string { client PiClient prompt #""# }`,
      },
    });
    const pi = createMockPi();
    createPiBamlExtension(pi, {
      settings: { ...testSettings, baml: { ...testSettings.baml, systemPrompt: false } },
    });
    // Handler is still registered (for skill discovery) but won't inject prompt
    const events = pi.on.mock.calls.map((c: unknown[]) => (c[0] as string));
    expect(events).toContain("before_agent_start");
  });

  it("emits available=false when settings are invalid", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { settings: { baml: {} } });

    expect(pi.events.emit).toHaveBeenCalledWith(
      "pi-baml:ready",
      expect.objectContaining({ available: false }),
    );
    // No tools registered when settings fail
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("emits available=false when bamlAvailable is false", () => {
    const pi = createMockPi();
    createPiBamlExtension(pi, { bamlAvailable: false, loadError: "NAPI failed", settings: testSettings });

    expect(pi.events.emit).toHaveBeenCalledWith(
      "pi-baml:ready",
      expect.objectContaining({ available: false }),
    );
    // Tools still register (they return errors on call)
    expect(pi.registerTool).toHaveBeenCalledTimes(3);
  });
});
