import { spawn } from "node:child_process";
import { createRedactor, truncateText } from "./redaction.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const CAPTURE_LIMIT_BYTES = 1024 * 1024;

export interface ProcessExecution {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stdoutOmittedBytes?: number;
  stderrOmittedBytes?: number;
}

export interface ProcessRunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProcessExecutor {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessExecution>;
}

export interface AdapterResult extends ProcessExecution {
  outcome: "success" | "failure" | "outcome-unknown";
  truncation: {
    stdoutOmittedBytes: number;
    stderrOmittedBytes: number;
  };
}

export class NodeProcessExecutor implements ProcessExecutor {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessExecution> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stdoutOmittedBytes = 0;
      let stderrOmittedBytes = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const append = (current: string, chunk: Buffer | string) => {
        const bounded = truncateText(current + chunk.toString(), CAPTURE_LIMIT_BYTES);
        return { text: bounded.text, omittedBytes: bounded.omittedBytes };
      };
      const finish = (execution: ProcessExecution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolve(execution);
      };
      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        const bounded = append(stdout, chunk);
        stdout = bounded.text;
        stdoutOmittedBytes += bounded.omittedBytes;
      });
      child.stderr.on("data", (chunk) => {
        const bounded = append(stderr, chunk);
        stderr = bounded.text;
        stderrOmittedBytes += bounded.omittedBytes;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (exitCode) => finish({
        exitCode,
        stdout,
        stderr,
        timedOut,
        aborted,
        stdoutOmittedBytes,
        stderrOmittedBytes,
      }));
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

interface AdapterOptions {
  maxOutputBytes?: number;
  timeoutMs?: number;
  cwd?: string;
}

interface RunOptions {
  mutation?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class GitHubAdapter {
  private readonly redact: (value: string) => string;

  constructor(
    private readonly executor: ProcessExecutor = new NodeProcessExecutor(),
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly options: AdapterOptions = {},
  ) {
    this.redact = createRedactor([
      baseEnv.GH_TOKEN,
      baseEnv.GITHUB_TOKEN,
      baseEnv.GH_ENTERPRISE_TOKEN,
      baseEnv.GITHUB_ENTERPRISE_TOKEN,
    ]);
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<AdapterResult> {
    return this.execute(command, args, undefined, options);
  }

  runGit(args: string[], options: RunOptions = {}): Promise<AdapterResult> {
    return this.execute("git", args, undefined, options);
  }

  runGh(host: string, args: string[], options: RunOptions = {}): Promise<AdapterResult> {
    return this.execute("gh", args, host, options);
  }

  private async execute(
    command: string,
    args: string[],
    host: string | undefined,
    options: RunOptions,
  ): Promise<AdapterResult> {
    const execution = await this.executor.run(command, args, {
      cwd: this.options.cwd,
      env: this.commandEnv(host),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout = truncateText(this.redact(execution.stdout), maxBytes);
    const stderr = truncateText(this.redact(execution.stderr), maxBytes);
    const uncertain = execution.timedOut || execution.aborted;
    return {
      ...execution,
      stdout: stdout.text,
      stderr: stderr.text,
      outcome: uncertain && options.mutation
        ? "outcome-unknown"
        : execution.exitCode === 0 && !uncertain ? "success" : "failure",
      truncation: {
        stdoutOmittedBytes: (execution.stdoutOmittedBytes ?? 0) + stdout.omittedBytes,
        stderrOmittedBytes: (execution.stderrOmittedBytes ?? 0) + stderr.omittedBytes,
      },
    };
  }

  async resolveIdentity(host: string): Promise<{
    host: string;
    login: string;
    tokenShadowingIgnored: boolean;
  }> {
    const result = await this.executor.run(
      "gh",
      ["auth", "status", "--hostname", host, "--json", "hosts"],
      {
        cwd: this.options.cwd,
        env: this.commandEnv(host),
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(this.redact(result.stderr || `No authenticated GitHub account for ${host}.`));
    }

    const accounts = parseAuthAccounts(result.stdout, host);
    const selected = accounts.find((account) => account.active && account.state === "success")
      ?? accounts.find((account) => account.state === "success");
    if (!selected) throw new Error(`No valid authenticated GitHub account for ${host}.`);
    return {
      host,
      login: selected.login,
      tokenShadowingIgnored: Boolean(
        this.baseEnv.GH_TOKEN
        || this.baseEnv.GITHUB_TOKEN
        || this.baseEnv.GH_ENTERPRISE_TOKEN
        || this.baseEnv.GITHUB_ENTERPRISE_TOKEN,
      ),
    };
  }

  private commandEnv(host?: string): NodeJS.ProcessEnv {
    const env = { ...this.baseEnv };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    if (host) env.GH_HOST = host;
    return env;
  }
}

interface AuthAccount {
  login: string;
  active: boolean;
  state: string;
}

function parseAuthAccounts(value: string, host: string): AuthAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`GitHub authentication status for ${host} was not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || !("hosts" in parsed)) return [];
  const hosts = (parsed as { hosts?: Record<string, unknown> }).hosts;
  const accounts = hosts?.[host];
  if (!Array.isArray(accounts)) return [];
  return accounts.filter((account): account is AuthAccount =>
    Boolean(account)
    && typeof account === "object"
    && typeof (account as AuthAccount).login === "string"
    && typeof (account as AuthAccount).state === "string",
  );
}
