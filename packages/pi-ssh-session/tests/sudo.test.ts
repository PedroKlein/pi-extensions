import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sshSessionExtension from "../src/index.js";
import { type FakeSSH, installFakeSSH } from "./helpers.js";

interface PasswordDriver {
  value?: string;
  cancel?: boolean;
  calls: number;
  renders: string[];
  options: unknown[];
}

interface RegisteredExtension {
  tool: any;
  shutdown(): Promise<void>;
  entries: unknown[];
}

function context(driver?: PasswordDriver, hasUI = true): ExtensionContext {
  return {
    hasUI,
    ui: {
      confirm: async () => true,
      select: async () => "Prompt — confirm every command, sudo, upload, and download",
      custom: async (factory: any, options: unknown) => {
        if (!driver) throw new Error("Unexpected password prompt.");
        driver.calls++;
        driver.options.push(options);
        return new Promise<string | null>((resolve) => {
          const component = factory(
            { requestRender() {} },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
              inverse: (text: string) => text,
            },
            {},
            resolve,
          ) as Component;
          driver.renders.push(component.render(44).join("\n"));
          if (driver.cancel) {
            component.handleInput?.("\x1b");
            return;
          }
          for (const character of driver.value ?? "") component.handleInput?.(character);
          driver.renders.push(component.render(44).join("\n"));
          component.handleInput?.("\r");
        });
      },
    },
  } as unknown as ExtensionContext;
}

function registerExtension(): RegisteredExtension {
  const tools: any[] = [];
  const entries: unknown[] = [];
  let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: typeof shutdown) {
      if (event === "session_shutdown") shutdown = handler;
    },
    appendEntry(entry: unknown) {
      entries.push(entry);
    },
  } as unknown as ExtensionAPI;
  sshSessionExtension(pi);
  return {
    tool: tools[0],
    entries,
    async shutdown() {
      await shutdown?.({ type: "session_shutdown", reason: "quit" }, context());
    },
  };
}

async function call(tool: any, params: Record<string, unknown>, ctx = context()) {
  return tool.execute("sudo-test", params, undefined, undefined, ctx);
}

let fakeSSH: FakeSSH;
let originalPath: string | undefined;
let extension: RegisteredExtension;

beforeEach(async () => {
  fakeSSH = await installFakeSSH();
  originalPath = process.env.PATH;
  process.env.PATH = `${dirname(fakeSSH.command)}:${originalPath ?? ""}`;
  extension = registerExtension();
});

afterEach(async () => {
  await extension.shutdown();
  process.env.PATH = originalPath;
  await fakeSSH.cleanup();
});

describe("ssh_session sudo", () => {
  it("uses cached sudo without asking for a password", async () => {
    expect(extension.tool.parameters.properties).not.toHaveProperty("password");
    const driver: PasswordDriver = { calls: 0, renders: [], options: [] };
    await call(extension.tool, { action: "connect", host: "sudo-cached" });

    const result = await call(
      extension.tool,
      { action: "sudo", command: "printf root" },
      context(driver),
    );

    expect(result.content[0].text).toBe("root");
    expect(driver.calls).toBe(0);
    expect((await fakeSSH.sudoArguments()).map(({ args }) => args)).toEqual([
      ["-n", "true"],
      ["-n", "--", "bash", "-c", "printf root"],
    ]);
    const commandsBeforeBypass = await fakeSSH.commands();
    await expect(
      call(extension.tool, { action: "execute", command: "  sudo printf bypass" }),
    ).rejects.toThrow("Use action=sudo instead.");
    expect(await fakeSSH.commands()).toBe(commandsBeforeBypass);
  });

  it("prompts once, masks input, and relies on the remote sudo timestamp afterward", async () => {
    const driver: PasswordDriver = {
      value: fakeSSH.sudoPassword,
      calls: 0,
      renders: [],
      options: [],
    };
    await call(extension.tool, { action: "connect", host: "sudo-expired" });

    const first = await call(
      extension.tool,
      { action: "sudo", command: "printf first" },
      context(driver),
    );
    const second = await call(
      extension.tool,
      { action: "sudo", command: "printf second" },
      context(driver),
    );

    expect(first.content[0].text).toBe("first");
    expect(second.content[0].text).toBe("second");
    expect(driver.calls).toBe(1);
    expect((await fakeSSH.sudoArguments()).map(({ args }) => args)).toEqual([
      ["-n", "true"],
      ["-S", "-p", "", "-v"],
      ["-n", "--", "bash", "-c", "printf first"],
      ["-n", "true"],
      ["-n", "--", "bash", "-c", "printf second"],
    ]);
    expect(driver.options).toEqual([undefined]);
    expect(driver.renders.join("\n")).not.toContain(fakeSSH.sudoPassword);
    expect(driver.renders[1]).toContain("•".repeat(39));
  });

  it("never exposes the password through commands or public tool data", async () => {
    const driver: PasswordDriver = {
      value: fakeSSH.sudoPassword,
      calls: 0,
      renders: [],
      options: [],
    };
    await call(extension.tool, { action: "connect", host: "sudo-secret" });
    const result = await call(
      extension.tool,
      { action: "sudo", command: `printf "%s" "it's safe"` },
      context(driver),
    );

    expect(result.content[0].text).toBe("it's safe");
    const observableData = {
      result,
      entries: extension.entries,
      sshArguments: await fakeSSH.arguments(),
      commands: await fakeSSH.commands(),
      sudoArguments: await fakeSSH.sudoArguments(),
      renders: driver.renders,
    };
    expect(JSON.stringify(observableData)).not.toContain(fakeSSH.sudoPassword);
    expect(result.details).not.toHaveProperty("fullOutputPath");
  });

  it("handles cancellation, unavailable UI, and wrong passwords without retaining a secret", async () => {
    await call(extension.tool, { action: "connect", host: "sudo-errors" });

    const cancelled: PasswordDriver = { cancel: true, calls: 0, renders: [], options: [] };
    await expect(
      call(extension.tool, { action: "sudo", command: "printf cancelled" }, context(cancelled)),
    ).rejects.toThrow("Sudo authentication was cancelled.");

    const sudoCallsBeforeNoUI = await fakeSSH.sudoArguments();
    await expect(
      call(extension.tool, { action: "sudo", command: "printf unavailable" }, context(undefined, false)),
    ).rejects.toThrow("Remote command execution requires interactive approval.");
    expect(await fakeSSH.sudoArguments()).toEqual(sudoCallsBeforeNoUI);

    const wrong: PasswordDriver = { value: "wrong-password", calls: 0, renders: [], options: [] };
    await expect(
      call(extension.tool, { action: "sudo", command: "printf denied" }, context(wrong)),
    ).rejects.toThrow("Sudo authentication failed");
    expect(await fakeSSH.commands()).not.toContain("wrong-password");

    const correct: PasswordDriver = { value: fakeSSH.sudoPassword, calls: 0, renders: [], options: [] };
    await expect(
      call(extension.tool, { action: "sudo", command: "printf recovered" }, context(correct)),
    ).resolves.toMatchObject({ content: [{ text: "recovered" }] });
    expect(correct.calls).toBe(1);
  });

  it.each([
    ["sudo-timeout", "timed out", 50],
    ["sudo-drop", "connection", 1_000],
  ])("fails clearly when sudo authentication loses its session on %s", async (host, message, timeout) => {
    const driver: PasswordDriver = {
      value: fakeSSH.sudoPassword,
      calls: 0,
      renders: [],
      options: [],
    };
    await call(extension.tool, { action: "connect", host });

    await expect(
      call(extension.tool, { action: "sudo", command: "printf unreachable", timeout }, context(driver)),
    ).rejects.toThrow(new RegExp(message, "i"));
    await expect(call(extension.tool, { action: "status" })).resolves.toMatchObject({
      content: [{ text: "No active SSH session." }],
    });
  });
});
