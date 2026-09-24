import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const CONNECT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 65_536;
const MARKER_PREFIX = "\x1ePI_SSH_DONE_";
const MARKER_SUFFIX = "\x1f";
const SSH_OPTIONS_WITHOUT_VALUE = new Set(["-4", "-6", "-a", "-C", "-q", "-T", "-v", "-x"]);
const SSH_OPTIONS_WITH_VALUE = new Set(["-b", "-c", "-i", "-J", "-l", "-m", "-o", "-p"]);
const BLOCKED_SSH_CONFIG = new Set([
  "batchmode",
  "challengeresponseauthentication",
  "controlmaster",
  "controlpath",
  "controlpersist",
  "dynamicforward",
  "forkafterauthentication",
  "forwardagent",
  "forwardx11",
  "forwardx11trusted",
  "include",
  "kbdinteractiveauthentication",
  "knownhostscommand",
  "localcommand",
  "localforward",
  "match",
  "passwordauthentication",
  "permitlocalcommand",
  "preferredauthentications",
  "proxycommand",
  "remotecommand",
  "remoteforward",
  "requesttty",
  "serveralivecountmax",
  "serveraliveinterval",
  "sessiontype",
  "stdinnull",
  "stricthostkeychecking",
  "tunnel",
  "tunneldevice",
]);

export interface CommandResult {
  output: string;
  exitCode: number;
}

interface PendingCommand {
  id: string;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
}

export function validateSSHOptions(options: string[]): void {
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (SSH_OPTIONS_WITHOUT_VALUE.has(option) || /^-v+$/.test(option)) continue;

    const flag = option.slice(0, 2);
    if (!SSH_OPTIONS_WITH_VALUE.has(flag)) {
      throw new Error(`Invalid SSH option: ${JSON.stringify(option)}.`);
    }
    const value = option.length > 2 ? option.slice(2) : options[++index];
    if (!value || value.startsWith("-")) {
      throw new Error(`SSH option ${flag} requires a value.`);
    }
    if (flag === "-o") {
      const name = value.trim().split(/[=\s]/, 1)[0];
      if (BLOCKED_SSH_CONFIG.has(name.toLowerCase())) {
        throw new Error(`SSH option ${name} is not allowed.`);
      }
    }
  }
}

export class SSHSession {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdout = "";
  private stderr = "";
  private pending: PendingCommand | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sshCommand = "ssh",
    private readonly onDisconnect?: () => void,
  ) {}

  get connected(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  async connect(host: string, options: string[] = [], signal?: AbortSignal): Promise<void> {
    validateSSHOptions(options);
    await this.disconnect();
    signal?.throwIfAborted();

    const child = spawn(
      this.sshCommand,
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
        ...options,
        "--",
        host,
        "bash",
        "-l",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.process = child;
    this.stdout = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      this.stdout += data;
      this.checkOutput();
    });
    child.stdin.on("error", (error) => this.fail(child, error));
    child.stderr.on("data", (data: string) => {
      this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => this.fail(child, error));
    child.on("close", () => {
      const message = this.stderr.trim() || "SSH connection closed.";
      this.fail(child, new Error(message));
    });

    try {
      await this.run("true", CONNECT_TIMEOUT_MS, signal);
    } catch (error) {
      const message = this.stderr.trim();
      await this.disconnect();
      throw new Error(
        `Failed to connect to ${host}: ${message || (error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  execute(
    command: string,
    timeout = COMMAND_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.enqueue(command, timeout, signal);
  }

  executeWithInputLine(
    command: string,
    input: string | Uint8Array,
    timeout = COMMAND_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.enqueue(command, timeout, signal, input);
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.onDisconnect?.();
    this.pending?.reject(new Error("SSH connection closed."));
    this.pending = null;
    this.stdout = "";
    this.stderr = "";
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      child.once("close", resolve);
      child.kill();
    });
  }

  private enqueue(
    command: string,
    timeout: number,
    signal?: AbortSignal,
    input?: string | Uint8Array,
  ): Promise<CommandResult> {
    const child = this.process;
    const operation = this.queue.then(() => {
      if (this.process !== child) throw new Error("SSH session changed before command execution.");
      const result = this.run(command, timeout, signal, input);
      input = undefined;
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private run(
    command: string,
    timeout: number,
    signal?: AbortSignal,
    input?: string | Uint8Array,
  ): Promise<CommandResult> {
    const child = this.process;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(new Error("No active SSH session."));
    }
    signal?.throwIfAborted();

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = <T>(callback: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.pending?.id === id) this.pending = null;
        callback(value);
      };
      const abort = () => {
        const reason = signal?.reason;
        finish(reject, reason instanceof Error ? reason : new Error("SSH operation aborted."));
        void this.disconnect();
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(`SSH command timed out after ${timeout}ms.`));
        void this.disconnect();
      }, timeout);

      this.pending = {
        id,
        resolve: (result) => finish(resolve, result),
        reject: (error) => finish(reject, error),
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`{\n${command}\n} 2>&1\n`);
      if (input !== undefined) {
        child.stdin.write(input);
        child.stdin.write("\n");
        input = undefined;
      }
      child.stdin.write(
        `__pi_ssh_ec=$?; printf '\\036PI_SSH_DONE_${id}:%s\\037\\n' "$__pi_ssh_ec"\n`,
      );
      this.checkOutput();
    });
  }

  private checkOutput(): void {
    const pending = this.pending;
    if (!pending) return;

    const marker = `${MARKER_PREFIX}${pending.id}:`;
    const start = this.stdout.indexOf(marker);
    if (start < 0) return;
    const end = this.stdout.indexOf(MARKER_SUFFIX, start + marker.length);
    if (end < 0) return;

    const exitCode = Number.parseInt(this.stdout.slice(start + marker.length, end), 10);
    const output = this.stdout.slice(0, start).trim();
    this.stdout = this.stdout.slice(end + MARKER_SUFFIX.length).replace(/^\r?\n/, "");
    pending.resolve({ output, exitCode });
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = null;
    this.onDisconnect?.();
    this.pending?.reject(error);
    this.pending = null;
  }
}
