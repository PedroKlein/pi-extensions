import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSHSession } from "../src/session.js";
import { type FakeSSH, installFakeSSH, waitFor } from "./helpers.js";

let fakeSSH: FakeSSH;
let session: SSHSession;

beforeEach(async () => {
  fakeSSH = await installFakeSSH();
  session = new SSHSession(fakeSSH.command);
});

afterEach(async () => {
  await session.disconnect();
  await fakeSSH.cleanup();
});

describe("SSHSession", () => {
  it("connects with safe OpenSSH defaults and preserves shell state", async () => {
    await session.connect("example-host", ["-p", "2222"]);
    await session.execute("cd /tmp && export PI_SSH_VALUE=preserved");

    const result = await session.execute('printf "%s:%s" "$PWD" "$PI_SSH_VALUE"');

    expect(result).toEqual({ output: "/tmp:preserved", exitCode: 0 });
    expect(await fakeSSH.arguments()).toEqual([
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ServerAliveInterval=60",
        "-o",
        "ServerAliveCountMax=3",
        "-p",
        "2222",
        "--",
        "example-host",
        "bash",
        "-l",
      ],
    ]);
  });

  it("rejects positional and command-executing SSH options without replacing the session", async () => {
    await session.connect("original-host");

    await expect(session.connect("other-host", ["unexpected-host"])).rejects.toThrow("Invalid SSH option");
    await expect(session.connect("other-host", ["-o", "ProxyCommand=touch /tmp/unapproved"])).rejects.toThrow(
      "SSH option ProxyCommand is not allowed",
    );

    expect(session.connected).toBe(true);
    expect(await fakeSSH.arguments()).toHaveLength(1);
  });

  it("serializes commands and keeps the session usable after a non-zero exit", async () => {
    await session.connect("queue-host");

    const first = session.execute("sleep 0.05; printf first");
    const second = session.execute("printf second >&2; false");

    await expect(first).resolves.toEqual({ output: "first", exitCode: 0 });
    await expect(second).resolves.toEqual({ output: "second", exitCode: 1 });
    await expect(session.execute("printf alive")).resolves.toEqual({
      output: "alive",
      exitCode: 0,
    });
  });

  it("reports connection stderr immediately", async () => {
    const startedAt = performance.now();

    await expect(session.connect("stderr-host")).rejects.toThrow(
      "Failed to connect to stderr-host: Permission denied (publickey).",
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("aborts a connection attempt and terminates its process", async () => {
    const controller = new AbortController();
    const operation = session.connect("slow-connect", [], controller.signal);
    await waitFor(
      async () => (await fakeSSH.arguments()).map((args) => args.at(-3) ?? ""),
      "slow-connect",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(operation).rejects.toThrow("Failed to connect to slow-connect");
    await waitFor(fakeSSH.exits, "slow-connect");
  });

  it("does not impose a default command timeout", async () => {
    await session.connect("no-timeout-host");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const operation = session.execute("sleep 0.05; printf alive");
      await vi.advanceTimersByTimeAsync(120_001);
      vi.useRealTimers();
      await expect(operation).resolves.toEqual({ output: "alive", exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["timeout", () => session.execute("sleep 10", 25), "timed out"],
    [
      "abort",
      () => {
        const controller = new AbortController();
        const operation = session.execute("sleep 10", 5_000, controller.signal);
        setTimeout(() => controller.abort(), 25);
        return operation;
      },
      "aborted",
    ],
  ])("closes the session after command %s", async (_name, run, message) => {
    await session.connect("cancel-host");

    await expect(run()).rejects.toThrow(message);
    await expect(session.execute("printf unreachable")).rejects.toThrow(
      "No active SSH session.",
    );
    await waitFor(fakeSSH.exits, "cancel-host");
  });

  it("rejects a pending command when the remote stream closes", async () => {
    await session.connect("close-host");

    await expect(session.execute("kill -KILL $$")).rejects.toThrow(
      "SSH connection closed.",
    );
    await expect(session.execute("printf unreachable")).rejects.toThrow(
      "No active SSH session.",
    );
  });

  it("disconnects and settles a pending command exactly once", async () => {
    await session.connect("disconnect-host");
    let rejections = 0;
    const operation = session.execute("sleep 10").then(
      () => undefined,
      (error: Error) => {
        rejections++;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    await session.disconnect();

    expect((await operation)?.message).toBe("SSH connection closed.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejections).toBe(1);
    await waitFor(fakeSSH.exits, "disconnect-host");
  });
});
