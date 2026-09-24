import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sshSessionExtension from "../src/index.js";
import { type FakeSSH, installFakeSSH } from "./helpers.js";

interface RegisteredExtension {
  tool: any;
  shutdown(): Promise<void>;
}

function context(
  cwd: string,
  confirm: (title: string, message: string) => Promise<boolean> = async () => true,
  hasUI = true,
): ExtensionContext {
  return {
    cwd,
    hasUI,
    ui: {
      confirm,
      select: async () => "Prompt — confirm every command, sudo, upload, and download",
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
      await shutdown?.({ type: "session_shutdown", reason: "quit" }, context(cwd));
    },
  };
}

async function call(
  tool: any,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return tool.execute("transfer-test", params, signal, undefined, ctx);
}

let fakeSSH: FakeSSH;
let originalPath: string | undefined;
let directory: string;
let extension: RegisteredExtension;

beforeEach(async () => {
  fakeSSH = await installFakeSSH();
  originalPath = process.env.PATH;
  process.env.PATH = `${dirname(fakeSSH.command)}:${originalPath ?? ""}`;
  directory = await mkdtemp(join(tmpdir(), "pi-ssh-transfer-test-"));
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

describe("ssh_session transfers", () => {
  it("validates transfer parameters before effects", async () => {
    const ctx = context(directory);
    expect(extension.tool.parameters.properties).toHaveProperty("localPath");
    expect(extension.tool.parameters.properties).toHaveProperty("remotePath");
    await expect(call(extension.tool, {
      action: "upload",
      remotePath: "/tmp/remote.bin",
    }, ctx)).rejects.toThrow('Action "upload" requires a non-empty localPath.');
    await expect(call(extension.tool, {
      action: "download",
      localPath: "local.bin",
    }, ctx)).rejects.toThrow('Action "download" requires a non-empty remotePath.');
    await expect(call(extension.tool, {
      action: "upload",
      localPath: "local.bin",
      remotePath: "/tmp/remote.bin",
      command: "true",
    }, ctx)).rejects.toThrow('Action "upload" does not accept command.');
    expect(await fakeSSH.arguments()).toEqual([]);
  });

  it("round-trips arbitrary binary bytes over the active session without returning contents", async () => {
    const secret = `TRANSFER_SECRET_${randomUUID()}`;
    const bytes = Buffer.concat([
      Buffer.from([0, 1, 2, 10, 13, 127, 128, 254, 255]),
      Buffer.from(secret),
    ]);
    await writeFile(join(directory, "source.bin"), bytes);
    const remotePath = join(directory, "remote.bin");
    const ctx = context(directory);
    await call(extension.tool, { action: "connect", host: "transfer-roundtrip" }, ctx);

    const uploaded = await call(extension.tool, {
      action: "upload",
      localPath: "source.bin",
      remotePath,
    }, ctx);
    const downloaded = await call(extension.tool, {
      action: "download",
      remotePath,
      localPath: "destination.bin",
    }, ctx);

    expect(await readFile(join(directory, "destination.bin"))).toEqual(bytes);
    expect(uploaded).toMatchObject({
      content: [{ text: `Uploaded ${JSON.stringify(join(directory, "source.bin"))} to ${JSON.stringify(`transfer-roundtrip:${remotePath}`)} (${bytes.length} bytes).` }],
      details: {
        action: "upload",
        host: "transfer-roundtrip",
        localPath: join(directory, "source.bin"),
        remotePath,
        bytes: bytes.length,
      },
    });
    expect(downloaded).toMatchObject({
      content: [{ text: `Downloaded ${JSON.stringify(`transfer-roundtrip:${remotePath}`)} to ${JSON.stringify(join(directory, "destination.bin"))} (${bytes.length} bytes).` }],
      details: {
        action: "download",
        host: "transfer-roundtrip",
        localPath: join(directory, "destination.bin"),
        remotePath,
        bytes: bytes.length,
      },
    });
    expect(await fakeSSH.arguments()).toHaveLength(1);
    expect(JSON.stringify({
      uploaded,
      downloaded,
      commands: await fakeSSH.commands(),
      sshArguments: await fakeSSH.arguments(),
    })).not.toContain(secret);
  });

  it("keeps adversarial local and remote paths literal", async () => {
    const token = randomUUID();
    const sentinel = join(directory, `sentinel-${token}`);
    const sourceName = `local ' $() ;\n source-${token}.bin`;
    const destinationName = `download ' $() ;\n destination-${token}.bin`;
    const remotePath = `remote ' $(touch sentinel-${token}) ;\n file.bin`;
    const bytes = Buffer.from([0, 255, 10, 39, 36, 40, 41, 59]);
    await writeFile(join(directory, sourceName), bytes);
    const ctx = context(directory);
    await call(extension.tool, { action: "connect", host: "transfer-paths" }, ctx);
    await call(extension.tool, { action: "execute", command: `cd '${directory.replaceAll("'", `'\"'\"'`)}'` }, ctx);

    await call(extension.tool, { action: "upload", localPath: sourceName, remotePath }, ctx);
    await call(extension.tool, { action: "download", remotePath, localPath: destinationName }, ctx);

    expect(await readFile(join(directory, remotePath))).toEqual(bytes);
    expect(await readFile(join(directory, destinationName))).toEqual(bytes);
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires approval with both paths before transfer effects", async () => {
    const source = join(directory, "approval-source.bin");
    const remote = join(directory, "approval-remote.bin");
    const destination = join(directory, "approval-destination.bin");
    await Promise.all([
      writeFile(source, "local-original"),
      writeFile(remote, "remote-original"),
      writeFile(destination, "destination-original"),
    ]);
    const ctx = context(directory);
    await call(extension.tool, { action: "connect", host: "transfer-approval" }, ctx);
    const before = await fakeSSH.commands();
    const confirmations: Array<[string, string]> = [];
    const denied = context(directory, async (title, message) => {
      confirmations.push([title, message]);
      return false;
    });

    await expect(call(extension.tool, {
      action: "upload",
      localPath: "approval-source.bin",
      remotePath: remote,
    }, denied)).rejects.toThrow("File transfer was not approved.");
    await expect(call(extension.tool, {
      action: "download",
      remotePath: remote,
      localPath: "approval-destination.bin",
    }, denied)).rejects.toThrow("File transfer was not approved.");
    await expect(call(extension.tool, {
      action: "upload",
      localPath: "missing-before-approval.bin",
      remotePath: remote,
    }, denied)).rejects.toThrow("File transfer was not approved.");

    const noUI = context(directory, async () => true, false);
    await expect(call(extension.tool, {
      action: "upload",
      localPath: "approval-source.bin",
      remotePath: remote,
    }, noUI)).rejects.toThrow("File transfer requires interactive approval.");
    await expect(call(extension.tool, {
      action: "download",
      remotePath: remote,
      localPath: "approval-destination.bin",
    }, noUI)).rejects.toThrow("File transfer requires interactive approval.");

    expect(confirmations.slice(0, 2)).toEqual([
      ["Upload via SSH?", `Source: ${JSON.stringify(source)}\nDestination: ${JSON.stringify(`transfer-approval:${remote}`)}`],
      ["Download via SSH?", `Source: ${JSON.stringify(`transfer-approval:${remote}`)}\nDestination: ${JSON.stringify(destination)}`],
    ]);
    expect(await fakeSSH.commands()).toBe(before);
    expect(await readFile(source, "utf8")).toBe("local-original");
    expect(await readFile(remote, "utf8")).toBe("remote-original");
    expect(await readFile(destination, "utf8")).toBe("destination-original");
  });

  it("reports missing paths and transfer failures without overwriting a download destination", async () => {
    const ctx = context(directory);
    const destination = join(directory, "existing.bin");
    const source = join(directory, "source.bin");
    await Promise.all([
      writeFile(destination, "keep-me"),
      writeFile(source, "upload-me"),
    ]);
    await call(extension.tool, { action: "connect", host: "transfer-errors" }, ctx);

    await expect(call(extension.tool, {
      action: "upload",
      localPath: "missing.bin",
      remotePath: join(directory, "unused.bin"),
    }, ctx)).rejects.toThrow(`Failed to read local file ${JSON.stringify(join(directory, "missing.bin"))}`);
    await expect(call(extension.tool, {
      action: "download",
      remotePath: join(directory, "remote-missing.bin"),
      localPath: "existing.bin",
    }, ctx)).rejects.toThrow("Failed to download");
    await expect(call(extension.tool, {
      action: "download",
      remotePath: source,
      localPath: "missing-directory/destination.bin",
    }, ctx)).rejects.toThrow("Failed to write local file");
    expect(await readFile(destination, "utf8")).toBe("keep-me");

    await call(extension.tool, { action: "connect", host: "transfer-failure" }, ctx);
    await expect(call(extension.tool, {
      action: "upload",
      localPath: "source.bin",
      remotePath: join(directory, "failed.bin"),
    }, ctx)).rejects.toThrow("remote command exited with code 42");

    await call(extension.tool, { action: "connect", host: "transfer-invalid" }, ctx);
    await expect(call(extension.tool, {
      action: "download",
      remotePath: source,
      localPath: "existing.bin",
    }, ctx)).rejects.toThrow("remote output was not valid base64");
    expect(await readFile(destination, "utf8")).toBe("keep-me");
  });

  it.each([
    ["abort", 5_000],
    ["timeout", 50],
  ])("fails clearly when a transfer hits %s", async (kind, timeout) => {
    const ctx = context(directory);
    const remote = join(directory, "blocked.bin");
    await writeFile(remote, "blocked");
    await call(extension.tool, { action: "connect", host: "transfer-timeout" }, ctx);
    const controller = new AbortController();

    const operation = call(extension.tool, {
      action: "download",
      remotePath: remote,
      localPath: "unreachable.bin",
      timeout,
    }, ctx, controller.signal);
    if (kind === "abort") setTimeout(() => controller.abort(new Error("Transfer cancelled.")), 20);

    await expect(operation).rejects.toThrow(kind === "abort" ? "Transfer cancelled." : "timed out");
    await expect(call(extension.tool, { action: "status" }, ctx)).resolves.toMatchObject({
      content: [{ text: "No active SSH session." }],
    });
    await expect(access(join(directory, "unreachable.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for existing Pi mutations before writing a download", async () => {
    const ctx = context(directory);
    const remote = join(directory, "queued-remote.bin");
    const destination = join(directory, "queued-local.bin");
    await Promise.all([
      writeFile(remote, "downloaded"),
      writeFile(destination, "original"),
    ]);
    await call(extension.tool, { action: "connect", host: "transfer-queue" }, ctx);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = withFileMutationQueue(destination, async () => {
      entered();
      await gate;
    });
    await active;

    const transfer = call(extension.tool, {
      action: "download",
      remotePath: remote,
      localPath: "queued-local.bin",
    }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(destination, "utf8")).toBe("original");
    release();
    await Promise.all([blocker, transfer]);
    expect(await readFile(destination, "utf8")).toBe("downloaded");
  });
});
