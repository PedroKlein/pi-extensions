import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sshSessionExtension from "../src/index.js";
import { type FakeSSH, installFakeSSH, waitFor } from "./helpers.js";

interface RegisteredExtension {
  tools: any[];
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => any>>;
}

function registerExtension(): RegisteredExtension {
  const tools: any[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  sshSessionExtension(pi);
  const extension = { tools, handlers };
  activeExtensions.push(extension);
  return extension;
}

function context(
  confirm: (title: string, message: string) => Promise<boolean> = async () => true,
  hasUI = true,
  select: (title: string, options: string[]) => Promise<string | undefined> = async () =>
    "Prompt — confirm every command, sudo, upload, and download",
): ExtensionContext {
  return {
    hasUI,
    ui: { confirm, select },
  } as unknown as ExtensionContext;
}

async function call(tool: any, params: Record<string, unknown>, ctx = context()) {
  return tool.execute("test-call", params, undefined, undefined, ctx);
}

let fakeSSH: FakeSSH;
let originalPath: string | undefined;
let activeExtensions: RegisteredExtension[];

beforeEach(async () => {
  activeExtensions = [];
  fakeSSH = await installFakeSSH();
  originalPath = process.env.PATH;
  process.env.PATH = `${dirname(fakeSSH.command)}:${originalPath ?? ""}`;
});

afterEach(async () => {
  for (const extension of activeExtensions) {
    for (const shutdown of extension.handlers.get("session_shutdown") ?? []) {
      await shutdown({ type: "session_shutdown", reason: "quit" }, context());
    }
  }
  process.env.PATH = originalPath;
  await fakeSSH.cleanup();
});

describe("ssh_session extension", () => {
  it("registers one tool with strict action parameters", async () => {
    const { tools } = registerExtension();
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("ssh_session");
    expect(tool.parameters.properties).toHaveProperty("cacheSudoPassword");
    expect(tool.parameters.properties).not.toHaveProperty("mode");
    expect(tool.parameters.properties).not.toHaveProperty("password");

    await expect(call(tool, { action: "connect" })).rejects.toThrow(
      'Action "connect" requires a non-empty host.',
    );
    await expect(call(tool, { action: "execute" })).rejects.toThrow(
      'Action "execute" requires a non-empty command.',
    );
    await expect(call(tool, { action: "connect", host: "example-host", command: "pwd" })).rejects.toThrow(
      'Action "connect" does not accept command.',
    );
    await expect(call(tool, { action: "execute", command: "pwd", host: "example-host" })).rejects.toThrow(
      'Action "execute" does not accept host.',
    );
    await expect(call(tool, { action: "status", command: "pwd" })).rejects.toThrow(
      'Action "status" does not accept command.',
    );
    await expect(call(tool, { action: "disconnect", host: "example-host" })).rejects.toThrow(
      'Action "disconnect" does not accept host.',
    );
    await expect(call(tool, { action: "connect", host: "example-host", mode: "yolo" })).rejects.toThrow(
      'Action "connect" does not accept mode.',
    );
    await expect(call(tool, { action: "status", cacheSudoPassword: true })).rejects.toThrow(
      'Action "status" does not accept cacheSudoPassword.',
    );

    await expect(call(tool, { action: "connect", host: "example-host" })).resolves.toMatchObject({
      content: [{ type: "text", text: "Connected to example-host." }],
    });
    await expect(call(tool, { action: "status" })).resolves.toMatchObject({
      content: [{ type: "text", text: "Connected to example-host (prompt mode)." }],
      details: { mode: "prompt" },
    });
    await expect(call(tool, { action: "execute", command: "printf ok" })).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    await expect(call(tool, { action: "disconnect" })).resolves.toMatchObject({
      content: [{ type: "text", text: "Disconnected from example-host." }],
    });
  });

  it("accepts neutral placeholders from Pi's generated tool wrapper", async () => {
    const { tools } = registerExtension();
    const [tool] = tools;
    const wrapperParams = {
      host: "",
      options: [],
      command: "",
      localPath: "",
      remotePath: "",
      timeout: 10_000,
      mode: "",
      cacheSudoPassword: false,
    };

    await expect(call(tool, { ...wrapperParams, action: "connect", host: "wrapper-host" })).resolves.toMatchObject({
      content: [{ text: "Connected to wrapper-host." }],
    });
    await expect(call(tool, { ...wrapperParams, action: "status" })).resolves.toMatchObject({
      content: [{ text: "Connected to wrapper-host (prompt mode)." }],
      details: { mode: "prompt" },
    });
    await expect(call(tool, { ...wrapperParams, action: "execute", command: "printf wrapper-ok" })).resolves.toMatchObject({
      content: [{ text: "wrapper-ok" }],
    });
    await expect(call(tool, { ...wrapperParams, action: "disconnect" })).resolves.toMatchObject({
      content: [{ text: "Disconnected from wrapper-host." }],
    });
  });

  it("requires approval before connecting or executing", async () => {
    const { tools } = registerExtension();
    const [tool] = tools;
    const confirmations: Array<[string, string]> = [];
    const selections: Array<[string, string[]]> = [];
    const approvingContext = context(
      async (title, message) => {
        confirmations.push([title, message]);
        return true;
      },
      true,
      async (title, options) => {
        selections.push([title, options]);
        return options[0];
      },
    );

    await call(tool, {
      action: "connect",
      host: "approval-host",
      options: ["-p", "2222", "-l", "deploy"],
    }, approvingContext);
    const denied = context(async (title, message) => {
      confirmations.push([title, message]);
      return false;
    });
    await expect(call(tool, { action: "execute", command: "export DENIED=yes" }, denied)).rejects.toThrow(
      "Remote command was not approved.",
    );
    const result = await call(
      tool,
      { action: "execute", command: 'printf "%s" "${DENIED-unset}"' },
      approvingContext,
    );

    expect(selections).toEqual([[
      'Connect via SSH?\nHost: "approval-host"\nOptions: "-p" "2222" "-l" "deploy"',
      [
        "Prompt — confirm every command, sudo, upload, and download",
        "YOLO — run commands, sudo, uploads, and downloads without further approval",
      ],
    ]]);
    expect(confirmations).toEqual([
      ["Run on approval-host?", "export DENIED=yes"],
      ["Run on approval-host?", 'printf "%s" "${DENIED-unset}"'],
    ]);
    expect(result.content[0].text).toBe("unset");

    const before = await fakeSSH.arguments();
    let invalidOptionPrompted = false;
    await expect(call(tool, {
      action: "connect",
      host: "hidden-host",
      options: ["other-host"],
    }, context(
      async () => {
        invalidOptionPrompted = true;
        return true;
      },
      true,
      async () => {
        invalidOptionPrompted = true;
        return "Prompt — confirm every command, sudo, upload, and download";
      },
    ))).rejects.toThrow("Invalid SSH option");
    expect(invalidOptionPrompted).toBe(false);

    await expect(
      call(tool, { action: "connect", host: "denied-host" }, context(
        async () => true,
        true,
        async () => undefined,
      )),
    ).rejects.toThrow("SSH connection was not approved.");
    expect(await fakeSSH.arguments()).toEqual(before);

    const noUI = context(async () => true, false);
    await expect(call(tool, { action: "execute", command: "export BLOCKED=yes" }, noUI)).rejects.toThrow(
      "Remote command execution requires interactive approval.",
    );
    await expect(call(tool, { action: "connect", host: "blocked-host" }, noUI)).rejects.toThrow(
      "Connecting via SSH requires interactive approval.",
    );
    expect(await fakeSSH.arguments()).toEqual(before);
    await expect(
      call(tool, { action: "execute", command: 'printf "%s" "${BLOCKED-unset}"' }, approvingContext),
    ).resolves.toMatchObject({ content: [{ text: "unset" }] });
  });

  it("throws on a failed remote command and remains connected", async () => {
    const { tools } = registerExtension();
    const [tool] = tools;
    await call(tool, { action: "connect", host: "failure-host" });

    await expect(call(tool, { action: "execute", command: "printf failed; false" })).rejects.toThrow(
      "failed\n\nCommand exited with code 1.",
    );
    await expect(call(tool, { action: "status" })).resolves.toMatchObject({
      content: [{ text: "Connected to failure-host (prompt mode)." }],
      details: { mode: "prompt" },
    });

    await expect(call(tool, { action: "connect", host: "stderr-host" })).rejects.toThrow(
      "Permission denied",
    );
    await expect(call(tool, { action: "status" })).resolves.toMatchObject({
      content: [{ text: "No active SSH session." }],
    });
  });

  it("truncates large command output and saves the exact full output owner-only", async () => {
    const { tools } = registerExtension();
    const [tool] = tools;
    await call(tool, { action: "connect", host: "large-host" });

    const lines = Array.from({ length: 2_501 }, (_, index) => `line-${index + 1}`);
    const result = await call(tool, {
      action: "execute",
      command: "for i in $(seq 1 2501); do echo line-$i; done",
    });

    expect(result.details.truncation.truncated).toBe(true);
    expect(result.details.truncation.outputLines).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(result.details.truncation.content)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content[0].text).toContain("Full output saved to:");
    expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(lines.join("\n"));
    expect((await stat(result.details.fullOutputPath)).mode & 0o777).toBe(0o600);
  });

  it("cleans up on shutdown and adds guidance without intercepting bash", async () => {
    const { tools, handlers } = registerExtension();
    const [tool] = tools;
    await call(tool, { action: "connect", host: "shutdown-host" });

    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(shutdown).toBeTypeOf("function");
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, context());
    await waitFor(fakeSSH.exits, "shutdown-host");

    expect(tool.promptGuidelines.join(" ")).toContain("Prefer ssh_session");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    expect(tool.renderCall({ action: "execute", command: "pwd" }, theme).render(120)[0].trimEnd()).toBe(
      "ssh execute pwd",
    );
    expect(
      tool.renderResult({ content: [], details: { action: "execute" } }, { isPartial: false }, theme).render(120)[0].trimEnd(),
    ).toBe("Done");
    expect(handlers.has("tool_call")).toBe(false);
    expect(handlers.has("user_bash")).toBe(false);
  });
});
