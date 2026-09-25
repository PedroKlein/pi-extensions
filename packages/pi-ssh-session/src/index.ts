import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateLine,
  truncateTail,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promptSudoPassword } from "./password-prompt.js";
import { SSHSession, type CommandResult, validateSSHOptions } from "./session.js";
import { download, shellQuote, upload } from "./transfers.js";

const Parameters = Type.Object({
  action: Type.Union([
    Type.Literal("connect"),
    Type.Literal("execute"),
    Type.Literal("status"),
    Type.Literal("disconnect"),
    Type.Literal("sudo"),
    Type.Literal("upload"),
    Type.Literal("download"),
  ]),
  host: Type.Optional(Type.String({ description: "SSH host for connect, such as user@example.com" })),
  options: Type.Optional(Type.Array(Type.String({ description: "Supported OpenSSH option tokens" }))),
  command: Type.Optional(Type.String({ description: "Remote shell command for execute or sudo" })),
  localPath: Type.Optional(Type.String({ description: "Local source or destination path for file transfer" })),
  remotePath: Type.Optional(Type.String({ description: "Remote source or destination path for file transfer" })),
  files: Type.Optional(Type.Array(Type.Object({
    localPath: Type.String({ description: "Local source or destination path" }),
    remotePath: Type.String({ description: "Remote source or destination path" }),
  }), { description: "Multiple local/remote path pairs for upload or download" })),
  timeout: Type.Optional(Type.Number({ minimum: 0, default: 0, description: "Operation timeout in milliseconds; 0 or omitted waits indefinitely" })),
  cacheSudoPassword: Type.Optional(Type.Boolean({ description: "If the user chooses YOLO, prompt once and retain the sudo password in memory for this connection" })),
});

type Parameters = {
  action: "connect" | "execute" | "status" | "disconnect" | "sudo" | "upload" | "download";
  host?: string;
  options?: string[];
  command?: string;
  localPath?: string;
  remotePath?: string;
  files?: TransferFile[];
  timeout?: number;
  cacheSudoPassword?: boolean;
};

interface TransferFile {
  localPath: string;
  remotePath: string;
}

type ConnectionMode = "prompt" | "yolo";

const PROMPT_MODE = "Prompt — confirm every command, sudo, upload, and download";
const YOLO_MODE = "YOLO — run commands, sudo, uploads, and downloads without further approval";

interface Details {
  action: Parameters["action"];
  host?: string;
  exitCode?: number;
  truncation?: ReturnType<typeof truncateTail>;
  fullOutputPath?: string;
  localPath?: string;
  remotePath?: string;
  bytes?: number;
  files?: Array<TransferFile & { bytes: number }>;
  mode?: ConnectionMode;
}

function validate(params: Parameters): void {
  if (!params || !["connect", "execute", "status", "disconnect", "sudo", "upload", "download"].includes(params.action)) {
    throw new Error('action must be one of "connect", "execute", "status", "disconnect", "sudo", "upload", or "download".');
  }
  const allowed: Record<Parameters["action"], Set<keyof Parameters>> = {
    connect: new Set(["action", "host", "options", "timeout", "cacheSudoPassword"]),
    execute: new Set(["action", "command", "timeout"]),
    status: new Set(["action", "timeout"]),
    disconnect: new Set(["action", "timeout"]),
    sudo: new Set(["action", "command", "timeout"]),
    upload: new Set(["action", "localPath", "remotePath", "files", "timeout"]),
    download: new Set(["action", "localPath", "remotePath", "files", "timeout"]),
  };
  const required = params.action === "connect" ? "host" : ["execute", "sudo"].includes(params.action) ? "command" : undefined;
  if (required && (typeof params[required] !== "string" || !params[required].trim())) {
    throw new Error(`Action "${params.action}" requires a non-empty ${required}.`);
  }
  if (params.cacheSudoPassword !== undefined && typeof params.cacheSudoPassword !== "boolean") {
    throw new Error("cacheSudoPassword must be a boolean.");
  }
  if (["upload", "download"].includes(params.action)) {
    if (params.files !== undefined && !Array.isArray(params.files)) {
      throw new Error(`Action "${params.action}" files must be an array.`);
    }
    const hasBatch = (params.files?.length ?? 0) > 0;
    const hasLocalPath = typeof params.localPath === "string" && params.localPath.length > 0;
    const hasRemotePath = typeof params.remotePath === "string" && params.remotePath.length > 0;
    if (hasBatch && (hasLocalPath || hasRemotePath)) {
      throw new Error(`Action "${params.action}" accepts either localPath and remotePath or files, not both.`);
    }
    if (hasBatch) {
      params.files!.forEach((file, index) => {
        for (const path of ["localPath", "remotePath"] as const) {
          if (typeof file[path] !== "string" || !file[path]) {
            throw new Error(`Action "${params.action}" files[${index}] requires a non-empty ${path}.`);
          }
        }
      });
    } else if (params.files !== undefined && !hasLocalPath && !hasRemotePath) {
      throw new Error(`Action "${params.action}" requires localPath and remotePath, or non-empty files.`);
    } else {
      for (const path of ["localPath", "remotePath"] as const) {
        if (typeof params[path] !== "string" || !params[path]) {
          throw new Error(`Action "${params.action}" requires a non-empty ${path}.`);
        }
      }
    }
  }
  for (const key of Object.keys(params) as Array<keyof Parameters>) {
    const value = params[key];
    const neutral = value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
    if (!allowed[params.action].has(key) && !neutral) {
      throw new Error(`Action "${params.action}" does not accept ${key}.`);
    }
  }
}

async function chooseConnectionMode(ctx: ExtensionContext, connection: string): Promise<ConnectionMode> {
  if (!ctx.hasUI) throw new Error("Connecting via SSH requires interactive approval.");
  const selected = await ctx.ui.select(
    `Connect via SSH?\n${connection}`,
    [PROMPT_MODE, YOLO_MODE],
  );
  if (selected === PROMPT_MODE) return "prompt";
  if (selected === YOLO_MODE) return "yolo";
  throw new Error("SSH connection was not approved.");
}

async function approve(
  ctx: ExtensionContext,
  title: string,
  message: string,
  missingUI: string,
  denied: string,
): Promise<void> {
  if (!ctx.hasUI) throw new Error(missingUI);
  if (!(await ctx.ui.confirm(title, message))) throw new Error(denied);
}

async function authenticateSudo(
  session: SSHSession,
  password: Uint8Array,
  timeout?: number,
  signal?: AbortSignal,
): Promise<void> {
  const authentication = await session.executeWithInputLine(
    "IFS= read -r __pi_sudo_password; printf '%s\\n' \"$__pi_sudo_password\" | sudo -S -p '' -v; __pi_sudo_ec=$?; unset __pi_sudo_password; (exit \"$__pi_sudo_ec\")",
    password,
    timeout,
    signal,
  );
  if (authentication.exitCode !== 0) throw new Error("Sudo authentication failed.");
}

async function formatOutput(result: CommandResult, details: Details) {
  const truncation = truncateTail(result.output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  details.exitCode = result.exitCode;
  if (!truncation.truncated) {
    return result.output || `(Command exited with code ${result.exitCode}.)`;
  }

  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-session-"));
  const fullOutputPath = join(directory, "output.txt");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, result.output, { mode: 0o600 }));
  details.truncation = truncation;
  details.fullOutputPath = fullOutputPath;
  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}

export default function sshSessionExtension(pi: ExtensionAPI): void {
  let cachedSudoPassword: Buffer | undefined;
  const clearSudoPassword = () => {
    cachedSudoPassword?.fill(0);
    cachedSudoPassword = undefined;
  };
  const session = new SSHSession("ssh", clearSudoPassword);
  let host: string | undefined;
  let connectionMode: ConnectionMode | undefined;

  pi.registerTool({
    name: "ssh_session",
    label: "SSH session",
    description: `Manage one persistent non-interactive SSH shell. Actions: connect, execute, status, disconnect, sudo, upload, download. Shell state persists between calls. Every connection asks the user to choose prompt or YOLO mode. Upload and download accept one path pair or a files array. Commands wait indefinitely unless timeout is set. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Connect to and run commands in one persistent remote SSH shell",
    promptGuidelines: [
      "Prefer ssh_session over local bash when the requested work targets a remote host.",
      "Use ssh_session status before assuming a connection exists; connect explicitly when needed.",
      "Use action=sudo for commands requiring elevated privileges; do not prefix action=execute commands with sudo.",
      "Use upload and download to transfer files over the active SSH session; prefer files for multiple path pairs.",
      "Use timeout=0 unless the user requested a finite operation timeout. An explicit timeout closes the connection so an unknown remote command cannot corrupt the shared shell.",
    ],
    parameters: Parameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validate(params);
      if (!session.connected) {
        host = undefined;
        connectionMode = undefined;
      }
      const details: Details = {
        action: params.action,
        host,
        mode: connectionMode,
      };
      const timeout = params.timeout && params.timeout > 0 ? params.timeout : undefined;

      if (params.action === "connect") {
        const target = params.host!.trim();
        const options = [...(params.options ?? [])];
        validateSSHOptions(options);
        const connection = `Host: ${JSON.stringify(target)}${options.length === 0 ? "" : `\nOptions: ${options.map((option) => JSON.stringify(option)).join(" ")}`}`;
        const requestedMode = await chooseConnectionMode(ctx, connection);
        host = undefined;
        connectionMode = undefined;
        await session.connect(target, options, signal);
        host = target;
        connectionMode = requestedMode;
        details.host = target;
        details.mode = requestedMode;
        if (requestedMode === "yolo" && params.cacheSudoPassword) {
          let password: Buffer | null = null;
          try {
            password = await promptSudoPassword(ctx);
            if (password === null) throw new Error("Sudo authentication was cancelled.");
            await authenticateSudo(session, password, timeout, signal);
            cachedSudoPassword = password;
            password = null;
          } catch (error) {
            password?.fill(0);
            await session.disconnect();
            host = undefined;
            connectionMode = undefined;
            throw error;
          }
        }
        const text = requestedMode === "yolo"
          ? `Connected to ${target} in YOLO mode.`
          : `Connected to ${target}.`;
        return { content: [{ type: "text" as const, text }], details };
      }

      if (params.action === "status") {
        const text = session.connected && host && connectionMode
          ? `Connected to ${host} (${connectionMode === "yolo" ? "YOLO" : "prompt"} mode).`
          : "No active SSH session.";
        return { content: [{ type: "text" as const, text }], details };
      }

      if (params.action === "disconnect") {
        const disconnectedHost = session.connected ? host : undefined;
        await session.disconnect();
        host = undefined;
        connectionMode = undefined;
        const text = disconnectedHost ? `Disconnected from ${disconnectedHost}.` : "No active SSH session.";
        return { content: [{ type: "text" as const, text }], details: { action: params.action, host: disconnectedHost } };
      }

      if (!session.connected || !host) throw new Error("No active SSH session. Use action=connect first.");
      if (params.action === "upload" || params.action === "download") {
        const isBatch = (params.files?.length ?? 0) > 0;
        const files = (isBatch ? params.files! : [{ localPath: params.localPath!, remotePath: params.remotePath! }])
          .map(({ localPath, remotePath }) => ({ localPath: resolve(ctx.cwd, localPath), remotePath }));
        const endpoints = files.map(({ localPath, remotePath }) => ({
          source: params.action === "upload" ? localPath : `${host}:${remotePath}`,
          destination: params.action === "upload" ? `${host}:${remotePath}` : localPath,
        }));
        if (connectionMode !== "yolo") {
          const message = isBatch
            ? endpoints.map(({ source, destination }, index) =>
              `File ${index + 1}:\nSource: ${JSON.stringify(source)}\nDestination: ${JSON.stringify(destination)}`,
            ).join("\n\n")
            : `Source: ${JSON.stringify(endpoints[0].source)}\nDestination: ${JSON.stringify(endpoints[0].destination)}`;
          await approve(
            ctx,
            params.action === "upload" ? "Upload via SSH?" : "Download via SSH?",
            message,
            "File transfer requires interactive approval.",
            "File transfer was not approved.",
          );
        }

        const completed: Array<TransferFile & { bytes: number }> = [];
        for (const file of files) {
          try {
            const bytes = params.action === "upload"
              ? await upload(session, file.localPath, file.remotePath, timeout, signal)
              : await download(session, file.remotePath, file.localPath, timeout, signal);
            completed.push({ ...file, bytes });
          } catch (error) {
            if (!isBatch) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Batch ${params.action} stopped after ${completed.length} of ${files.length} files: ${message}`);
          }
        }

        if (isBatch) {
          details.files = completed;
          const bytes = completed.reduce((total, file) => total + file.bytes, 0);
          const text = params.action === "upload"
            ? `Uploaded ${completed.length} files to ${host} (${bytes} bytes).`
            : `Downloaded ${completed.length} files from ${host} (${bytes} bytes).`;
          return { content: [{ type: "text" as const, text }], details };
        }

        const [file] = completed;
        details.localPath = file.localPath;
        details.remotePath = file.remotePath;
        details.bytes = file.bytes;
        const text = params.action === "upload"
          ? `Uploaded ${JSON.stringify(file.localPath)} to ${JSON.stringify(`${host}:${file.remotePath}`)} (${file.bytes} bytes).`
          : `Downloaded ${JSON.stringify(`${host}:${file.remotePath}`)} to ${JSON.stringify(file.localPath)} (${file.bytes} bytes).`;
        return { content: [{ type: "text" as const, text }], details };
      }

      const command = params.command!;
      if (params.action === "execute" && /^\s*sudo(?:\s|$)/.test(command)) {
        throw new Error("Direct sudo commands are not allowed through action=execute. Use action=sudo instead.");
      }
      if (connectionMode !== "yolo") {
        await approve(
          ctx,
          params.action === "sudo" ? `Run with sudo on ${host}?` : `Run on ${host}?`,
          command,
          "Remote command execution requires interactive approval.",
          "Remote command was not approved.",
        );
      }

      if (params.action === "sudo") {
        const preflight = await session.execute("sudo -n true", timeout, signal);
        if (preflight.exitCode !== 0) {
          if (!/password.*required/i.test(preflight.output)) {
            throw new Error(`Sudo is unavailable: ${preflight.output || `exit code ${preflight.exitCode}`}`);
          }
          if (connectionMode === "yolo") {
            if (!cachedSudoPassword) {
              throw new Error("Sudo authentication is required, but this YOLO connection has no cached sudo password.");
            }
            try {
              await authenticateSudo(session, cachedSudoPassword, timeout, signal);
            } catch (error) {
              clearSudoPassword();
              throw error;
            }
          } else {
            if (!ctx.hasUI) throw new Error("Sudo authentication requires interactive UI.");
            const password = await promptSudoPassword(ctx);
            if (password === null) throw new Error("Sudo authentication was cancelled.");
            try {
              await authenticateSudo(session, password, timeout, signal);
            } finally {
              password.fill(0);
            }
          }
        }
        const result = await session.execute(`sudo -n -- bash -c ${shellQuote(command)}`, timeout, signal);
        const text = await formatOutput(result, details);
        if (result.exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${result.exitCode}.`);
        return { content: [{ type: "text" as const, text }], details };
      }

      const result = await session.execute(command, timeout, signal);
      const text = await formatOutput(result, details);
      if (result.exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${result.exitCode}.`);
      return { content: [{ type: "text" as const, text }], details };
    },

    renderCall(args, theme) {
      const target = args.action === "connect"
        ? args.host
        : ["execute", "sudo"].includes(args.action)
          ? args.command
          : ["upload", "download"].includes(args.action)
            ? args.files?.length
              ? `${args.files.length} files`
              : `${args.localPath} ↔ ${args.remotePath}`
            : undefined;
      const preview = target ? truncateLine(target.replace(/\s+/g, " ").trim(), 120).text : "";
      const suffix = preview ? ` ${preview}` : "";
      return new Text(theme.fg("toolTitle", theme.bold(`ssh ${args.action}${suffix}`)), 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
      const details = result.details as Details | undefined;
      const summary = details?.truncation?.truncated ? "Done (output truncated)" : "Done";
      return new Text(theme.fg("success", summary), 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    await session.disconnect();
    host = undefined;
    connectionMode = undefined;
  });
}

export { SSHSession, type CommandResult } from "./session.js";
