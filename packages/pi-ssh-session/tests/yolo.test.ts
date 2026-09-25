import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sshSessionExtension from "../src/index.js";
import { type FakeSSH, installFakeSSH } from "./helpers.js";

interface RegisteredExtension {
  tool: any;
  shutdown(): Promise<void>;
}

const PROMPT_MODE = "Prompt — confirm every command, sudo, upload, and download";
const YOLO_MODE = "YOLO — run commands, sudo, uploads, and downloads without further approval";

interface PasswordDriver {
  values: Array<string | null>;
  calls: number;
  renders: string[];
  events: string[];
  options?: unknown[];
}

function context(
  cwd: string,
  confirm: (title: string, message: string) => Promise<boolean>,
  hasUI = true,
  passwordDriver?: PasswordDriver,
  select: (title: string, options: string[]) => Promise<string | undefined> = async () => YOLO_MODE,
): ExtensionContext {
  return {
    cwd,
    hasUI,
    ui: {
      confirm,
      select,
      custom: async (factory: any, options: unknown) => {
        if (!passwordDriver) throw new Error("Unexpected password prompt.");
        passwordDriver.calls++;
        passwordDriver.events.push("prompt");
        passwordDriver.options?.push(options);
        return new Promise<Buffer | null>((resolve) => {
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
          passwordDriver.renders.push(component.render(44).join("\n"));
          const value = passwordDriver.values.shift();
          if (value === null || value === undefined) {
            component.handleInput?.("\x1b");
            return;
          }
          for (const character of value) component.handleInput?.(character);
          passwordDriver.renders.push(component.render(44).join("\n"));
          component.handleInput?.("\r");
        });
      },
    },
  } as unknown as ExtensionContext;
}

function registerExtension(cwd: string): RegisteredExtension {
  const tools: any[] = [];
  let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: typeof shutdown) {
      if (event === "session_shutdown") shutdown = handler;
    },
  } as unknown as ExtensionAPI;
  sshSessionExtension(pi);
  return {
    tool: tools[0],
    async shutdown() {
      await shutdown?.({ type: "session_shutdown", reason: "quit" }, context(cwd, async () => true));
    },
  };
}

async function call(
  tool: any,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return tool.execute("yolo-test", params, signal, undefined, ctx);
}

let fakeSSH: FakeSSH;
let originalPath: string | undefined;
let directory: string;
let extension: RegisteredExtension;

beforeEach(async () => {
  fakeSSH = await installFakeSSH();
  originalPath = process.env.PATH;
  process.env.PATH = `${dirname(fakeSSH.command)}:${originalPath ?? ""}`;
  directory = await mkdtemp(join(tmpdir(), "pi-ssh-yolo-test-"));
  extension = registerExtension(directory);
});

afterEach(async () => {
  await extension.shutdown();
  process.env.PATH = originalPath;
  await Promise.all([
    fakeSSH.cleanup(),
    rm(directory, { recursive: true, force: true }),
  ]);
});

describe("ssh_session YOLO mode", () => {
  it("authorizes all remote effects once for the active connection", async () => {
    const source = join(directory, "source.bin");
    const remote = join(directory, "remote.bin");
    const destination = join(directory, "destination.bin");
    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    await writeFile(source, bytes);
    const selections: Array<[string, string[]]> = [];
    const ctx = context(
      directory,
      async () => {
        throw new Error("Unexpected confirmation.");
      },
      true,
      undefined,
      async (title, options) => {
        selections.push([title, options]);
        return YOLO_MODE;
      },
    );

    await call(extension.tool, { action: "connect", host: "sudo-cached" }, ctx);
    await expect(call(extension.tool, { action: "execute", command: "printf command-ok" }, ctx)).resolves.toMatchObject({
      content: [{ text: "command-ok" }],
    });
    await expect(call(extension.tool, { action: "sudo", command: "printf sudo-ok" }, ctx)).resolves.toMatchObject({
      content: [{ text: "sudo-ok" }],
    });
    await call(extension.tool, { action: "upload", localPath: source, remotePath: remote }, ctx);
    await call(extension.tool, { action: "download", localPath: destination, remotePath: remote }, ctx);

    expect(await readFile(destination)).toEqual(bytes);
    expect(selections).toEqual([[
      'Connect via SSH?\nHost: "sudo-cached"',
      [PROMPT_MODE, YOLO_MODE],
    ]]);
    await expect(call(extension.tool, { action: "status" }, ctx)).resolves.toMatchObject({
      content: [{ text: "Connected to sudo-cached (YOLO mode)." }],
      details: { mode: "yolo" },
    });
  });

  it("validates and caches a masked sudo password during YOLO connect", async () => {
    expect(extension.tool.parameters.properties).toHaveProperty("cacheSudoPassword");
    expect(extension.tool.parameters.properties).not.toHaveProperty("password");
    const driver: PasswordDriver = {
      values: [fakeSSH.sudoPassword],
      calls: 0,
      renders: [],
      events: [],
      options: [],
    };
    const ctx = context(
      directory,
      async () => true,
      true,
      driver,
      async () => {
        driver.events.push("select");
        return YOLO_MODE;
      },
    );

    const result = await call(extension.tool, {
      action: "connect",
      host: "sudo-yolo-cache",
      cacheSudoPassword: true,
    }, ctx);
    const status = await call(extension.tool, { action: "status" }, ctx);

    expect(result.content[0].text).toBe("Connected to sudo-yolo-cache in YOLO mode.");
    expect(driver.events).toEqual(["select", "prompt"]);
    expect(driver.calls).toBe(1);
    expect(driver.options).toEqual([undefined]);
    expect(driver.renders.join("\n")).not.toContain(fakeSSH.sudoPassword);
    expect((await fakeSSH.sudoArguments()).map(({ args }) => args)).toEqual([
      ["-S", "-p", "", "-v"],
    ]);
    expect(JSON.stringify({
      result,
      status,
      sshArguments: await fakeSSH.arguments(),
      commands: await fakeSSH.commands(),
      sudoArguments: await fakeSSH.sudoArguments(),
      renders: driver.renders,
    })).not.toContain(fakeSSH.sudoPassword);
  });

  it("ignores the sudo cache request when the user chooses prompt mode", async () => {
    const driver: PasswordDriver = {
      values: [fakeSSH.sudoPassword],
      calls: 0,
      renders: [],
      events: [],
    };
    const ctx = context(
      directory,
      async () => true,
      true,
      driver,
      async () => PROMPT_MODE,
    );

    await call(extension.tool, {
      action: "connect",
      host: "sudo-prompt-choice",
      cacheSudoPassword: true,
    }, ctx);

    expect(driver.calls).toBe(0);
    await expect(call(extension.tool, { action: "status" }, ctx)).resolves.toMatchObject({
      content: [{ text: "Connected to sudo-prompt-choice (prompt mode)." }],
    });
  });

  it("reauthenticates expired sudo from memory without UI", async () => {
    const driver: PasswordDriver = {
      values: [fakeSSH.sudoPassword],
      calls: 0,
      renders: [],
      events: [],
    };
    const ctx = context(directory, async () => true, true, driver);
    await call(extension.tool, {
      action: "connect",
      host: "sudo-yolo-expiry",
      cacheSudoPassword: true,
    }, ctx);
    await fakeSSH.expireSudo("sudo-yolo-expiry");

    await expect(call(extension.tool, {
      action: "sudo",
      command: "printf reauthenticated",
    }, ctx)).resolves.toMatchObject({ content: [{ text: "reauthenticated" }] });

    expect(driver.calls).toBe(1);
    expect((await fakeSSH.sudoArguments()).map(({ args }) => args)).toEqual([
      ["-S", "-p", "", "-v"],
      ["-n", "true"],
      ["-S", "-p", "", "-v"],
      ["-n", "--", "bash", "-c", "printf reauthenticated"],
    ]);
  });

  it("fails unattended sudo instead of prompting when no password was cached", async () => {
    const ctx = context(directory, async () => true);
    await call(extension.tool, {
      action: "connect",
      host: "sudo-yolo-no-cache",
    }, ctx);

    await expect(call(extension.tool, {
      action: "sudo",
      command: "printf unreachable",
    }, ctx)).rejects.toThrow("YOLO connection has no cached sudo password");
  });

  it("disconnects when connect-time sudo authentication is cancelled or rejected", async () => {
    const cancelled: PasswordDriver = { values: [null], calls: 0, renders: [], events: [] };
    await expect(call(extension.tool, {
      action: "connect",
      host: "sudo-yolo-cancelled",
      cacheSudoPassword: true,
    }, context(directory, async () => true, true, cancelled))).rejects.toThrow("Sudo authentication was cancelled.");
    await expect(call(extension.tool, { action: "status" }, context(directory, async () => true))).resolves.toMatchObject({
      content: [{ text: "No active SSH session." }],
    });

    const wrong: PasswordDriver = { values: ["wrong-password"], calls: 0, renders: [], events: [] };
    await expect(call(extension.tool, {
      action: "connect",
      host: "sudo-yolo-wrong",
      cacheSudoPassword: true,
    }, context(directory, async () => true, true, wrong))).rejects.toThrow("Sudo authentication failed.");
    await expect(call(extension.tool, { action: "status" }, context(directory, async () => true))).resolves.toMatchObject({
      content: [{ text: "No active SSH session." }],
    });
    expect(await fakeSSH.commands()).not.toContain("wrong-password");

    const noCache = context(directory, async () => true);
    await call(extension.tool, { action: "connect", host: "sudo-after-wrong" }, noCache);
    await expect(call(extension.tool, {
      action: "sudo",
      command: "printf must-not-run",
    }, noCache)).rejects.toThrow("YOLO connection has no cached sudo password");
  });

  it.each(["disconnect", "replacement", "timeout", "abort", "stream loss", "shutdown"])(
    "clears the cached sudo password after %s",
    async (ending) => {
      const driver: PasswordDriver = {
        values: [fakeSSH.sudoPassword],
        calls: 0,
        renders: [],
        events: [],
      };
      const ctx = context(directory, async () => true, true, driver);
      await call(extension.tool, {
        action: "connect",
        host: "sudo-yolo-lifecycle",
        cacheSudoPassword: true,
      }, ctx);

      const nextHost = `sudo-after-${ending.replaceAll(" ", "-")}`;
      if (ending === "disconnect") {
        await call(extension.tool, { action: "disconnect" }, ctx);
      } else if (ending === "replacement") {
        await call(extension.tool, { action: "connect", host: nextHost }, ctx);
      } else if (ending === "timeout") {
        await expect(call(extension.tool, {
          action: "execute",
          command: "sleep 10",
          timeout: 25,
        }, ctx)).rejects.toThrow("timed out");
      } else if (ending === "abort") {
        const controller = new AbortController();
        const operation = call(extension.tool, {
          action: "execute",
          command: "sleep 10",
          timeout: 5_000,
        }, ctx, controller.signal);
        setTimeout(() => controller.abort(), 25);
        await expect(operation).rejects.toThrow("aborted");
      } else if (ending === "stream loss") {
        await expect(call(extension.tool, {
          action: "execute",
          command: "kill -KILL $$",
        }, ctx)).rejects.toThrow("SSH connection closed");
      } else {
        await extension.shutdown();
      }

      if (ending !== "replacement") {
        await call(extension.tool, { action: "connect", host: nextHost }, ctx);
      }
      await expect(call(extension.tool, {
        action: "sudo",
        command: "printf must-not-run",
      }, ctx)).rejects.toThrow("YOLO connection has no cached sudo password");
      expect(driver.calls).toBe(1);
    },
  );

  it("accepts wrapper-shaped calls when the user selects prompt mode", async () => {
    const confirmations: Array<[string, string]> = [];
    const ctx = context(
      directory,
      async (title, message) => {
        confirmations.push([title, message]);
        return true;
      },
      true,
      undefined,
      async () => PROMPT_MODE,
    );
    const wrapper = {
      host: "",
      options: [],
      command: "",
      localPath: "",
      remotePath: "",
      files: [],
      timeout: 10_000,
      mode: "",
      cacheSudoPassword: false,
    };

    await call(extension.tool, { ...wrapper, action: "connect", host: "prompt-host" }, ctx);
    await call(extension.tool, { ...wrapper, action: "execute", command: "printf prompt-ok" }, ctx);

    expect(confirmations).toEqual([
      ["Run on prompt-host?", "printf prompt-ok"],
    ]);
    await expect(call(extension.tool, { ...wrapper, action: "status" }, ctx)).resolves.toMatchObject({
      content: [{ text: "Connected to prompt-host (prompt mode)." }],
      details: { mode: "prompt" },
    });
  });

  it("cancels connection setup when no approval mode is selected", async () => {
    const before = await fakeSSH.arguments();
    let chooser: [string, string[]] | undefined;
    const denied = context(
      directory,
      async () => true,
      true,
      undefined,
      async (title, options) => {
        chooser = [title, options];
        return undefined;
      },
    );
    await expect(call(extension.tool, {
      action: "connect",
      host: "denied-host",
      options: ["-p", "2222"],
    }, denied)).rejects.toThrow("SSH connection was not approved.");
    expect(chooser).toEqual([
      'Connect via SSH?\nHost: "denied-host"\nOptions: "-p" "2222"',
      [PROMPT_MODE, YOLO_MODE],
    ]);

    const noUI = context(directory, async () => true, false);
    await expect(call(extension.tool, {
      action: "connect",
      host: "no-ui-host",
    }, noUI)).rejects.toThrow("Connecting via SSH requires interactive approval.");
    expect(await fakeSSH.arguments()).toEqual(before);
  });

  it.each(["timeout", "abort", "stream loss", "shutdown"])(
    "resets YOLO authority after %s",
    async (ending) => {
      let confirmations = 0;
      let selections = 0;
      const modes = [YOLO_MODE, PROMPT_MODE];
      const ctx = context(
        directory,
        async () => {
          confirmations++;
          return true;
        },
        true,
        undefined,
        async () => {
          selections++;
          return modes.shift();
        },
      );
      await call(extension.tool, { action: "connect", host: "lifecycle-host" }, ctx);

      if (ending === "timeout") {
        await expect(call(extension.tool, {
          action: "execute",
          command: "sleep 10",
          timeout: 25,
        }, ctx)).rejects.toThrow("timed out");
      } else if (ending === "abort") {
        const controller = new AbortController();
        const operation = call(extension.tool, {
          action: "execute",
          command: "sleep 10",
          timeout: 5_000,
        }, ctx, controller.signal);
        setTimeout(() => controller.abort(), 25);
        await expect(operation).rejects.toThrow("aborted");
      } else if (ending === "stream loss") {
        await expect(call(extension.tool, {
          action: "execute",
          command: "kill -KILL $$",
        }, ctx)).rejects.toThrow("SSH connection closed");
      } else {
        await extension.shutdown();
      }

      await expect(call(extension.tool, { action: "status" }, ctx)).resolves.toMatchObject({
        content: [{ text: "No active SSH session." }],
        details: { mode: undefined },
      });
      await call(extension.tool, { action: "connect", host: "prompt-after-end" }, ctx);
      await call(extension.tool, { action: "execute", command: "printf prompt-again" }, ctx);
      expect(selections).toBe(2);
      expect(confirmations).toBe(1);
    },
  );

  it("resets YOLO authority when the connection ends or is replaced", async () => {
    let confirmations = 0;
    let selections = 0;
    const modes = [YOLO_MODE, PROMPT_MODE, YOLO_MODE, PROMPT_MODE];
    const ctx = context(
      directory,
      async () => {
        confirmations++;
        return true;
      },
      true,
      undefined,
      async () => {
        selections++;
        return modes.shift();
      },
    );

    await call(extension.tool, { action: "connect", host: "first-host" }, ctx);
    await call(extension.tool, { action: "disconnect" }, ctx);
    await call(extension.tool, { action: "connect", host: "second-host" }, ctx);
    await call(extension.tool, { action: "execute", command: "printf prompt-again" }, ctx);
    expect(selections).toBe(2);
    expect(confirmations).toBe(1);

    await call(extension.tool, { action: "connect", host: "replacement-host" }, ctx);
    await call(extension.tool, { action: "connect", host: "prompt-replacement" }, ctx);
    await call(extension.tool, { action: "execute", command: "printf prompt-after-replace" }, ctx);
    expect(selections).toBe(4);
    expect(confirmations).toBe(2);
  });
});
