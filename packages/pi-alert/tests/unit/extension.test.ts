import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import alertExtension from "../../src/index.js";

type Handler = (event: any, ctx: any) => unknown;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalTermProgram = process.env.TERM_PROGRAM;
const originalIsTTY = process.stdout.isTTY;

function createHarness() {
  const handlers = new Map<string, Handler>();
  const exec = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    exec,
  } as unknown as ExtensionAPI;

  alertExtension(pi);
  return { handlers, pi, exec };
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
  else process.env.TERM_PROGRAM = originalTermProgram;

  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
  vi.restoreAllMocks();
});

describe("configured tool alerts", () => {
  it("notifies when a configured tool starts", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-alert-test-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-alert": {
          toolAlerts: {
            ask_user: "Waiting for your answer",
          },
        },
      }),
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TERM_PROGRAM = "ghostty";
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const { handlers, exec } = createHarness();
      exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const sessionStart = handlers.get("session_start");
      expect(sessionStart, "pi-alert must load toolAlerts during session_start").toBeTypeOf("function");

      await sessionStart?.({}, {
        cwd: "/workspace/example",
        isProjectTrusted: () => false,
      });
      await handlers.get("agent_start")?.({}, {});
      await handlers.get("tool_execution_start")?.(
        { toolCallId: "call-1", toolName: "ask_user", args: {} },
        { cwd: "/workspace/example" },
      );

      if (process.platform === "darwin") {
        await vi.waitFor(() => {
          expect(exec).toHaveBeenCalledWith(
            "osascript",
            [
              "-e",
              'tell application id "com.mitchellh.ghostty" to display notification "Waiting for your answer" with title "pi — example" sound name "Glass"',
            ],
            { timeout: 5_000 },
          );
        });
        expect(write).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => {
          expect(write).toHaveBeenCalledWith(
            "\u001b]777;notify;pi — example;Waiting for your answer\u0007",
          );
        });
      }
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("ignores invalid tool alert entries", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-alert-test-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-alert": {
          toolAlerts: {
            ask_user: 42,
          },
        },
      }),
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TERM_PROGRAM = "ghostty";
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const { handlers } = createHarness();
      expect(() => handlers.get("session_start")?.({}, {
        cwd: "/workspace/example",
        isProjectTrusted: () => false,
      })).not.toThrow();
      await handlers.get("agent_start")?.({}, {});
      await handlers.get("tool_execution_start")?.(
        { toolCallId: "call-1", toolName: "ask_user", args: {} },
        { cwd: "/workspace/example" },
      );

      expect(write).not.toHaveBeenCalled();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("still notifies when the agent ends", async () => {
    process.env.TERM_PROGRAM = "ghostty";
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { handlers } = createHarness();

    await handlers.get("agent_start")?.({}, {});
    await handlers.get("agent_end")?.(
      { messages: [] },
      { cwd: "/workspace/example" },
    );

    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("\u001b]777;notify;pi — example;Finished"),
    );
  });
});
