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
  connection: Type.Optional(Type.String({ description: 'Connection name; defaults to "default"' })),
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
  connection?: string;
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
  connection?: string;
  connections?: Array<{ connection: string; host: string; mode: ConnectionMode }>;
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
    connect: new Set(["action", "connection", "host", "options", "timeout", "cacheSudoPassword"]),
    execute: new Set(["action", "connection", "command", "timeout"]),
    status: new Set(["action", "connection", "timeout"]),
    disconnect: new Set(["action", "connection", "timeout"]),
    sudo: new Set(["action", "connection", "command", "timeout"]),
    upload: new Set(["action", "connection", "localPath", "remotePath", "files", "timeout"]),
    download: new Set(["action", "connection", "localPath", "remotePath", "files", "timeout"]),
  };
  const required = params.action === "connect" ? "host" : ["execute", "sudo"].includes(params.action) ? "command" : undefined;
  if (required && (typeof params[required] !== "string" || !params[required].trim())) {
    throw new Error(`Action "${params.action}" requires a non-empty ${required}.`);
  }
  if (params.connection !== undefined && (typeof params.connection !== "string" || (params.connection !== "" && !params.connection.trim()))) {
    throw new Error("connection must be a non-empty string.");
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
  interface Connection {
    session: SSHSession;
    host?: string;
    mode?: ConnectionMode;
    cachedSudoPassword?: Buffer;
  }

  const connections = new Map<string, Connection>();
  const createConnection = (name: string) => {
    let connection: Connection;
    const session = new SSHSession("ssh", () => {
      connection.cachedSudoPassword?.fill(0);
      connection.cachedSudoPassword = undefined;
      connection.host = undefined;
      connection.mode = undefined;
      if (connections.get(name) === connection) connections.delete(name);
    });
    connection = { session };
    return connection;
  };

  pi.registerTool({
    name: "ssh_session",
    label: "SSH session",
    description: `Manage persistent non-interactive SSH shells. Actions: connect, execute, status, disconnect, sudo, upload, download. Use connection to keep multiple named shells alive; omitting it uses the default connection. Shell state persists between calls. Every connection asks the user to choose prompt or YOLO mode. Upload and download accept one path pair or a files array. Commands wait indefinitely unless timeout is set. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Connect to and run commands in persistent remote SSH shells",
    promptGuidelines: [
      "Prefer ssh_session over local bash when the requested work targets a remote host.",
      "Use distinct connection names when multiple SSH shells must remain alive; omit connection to use the backward-compatible default shell.",
      "Use ssh_session status before assuming a connection exists; connect explicitly when needed.",
      "Use action=sudo for commands requiring elevated privileges; do not prefix action=execute commands with sudo.",
      "Use upload and download to transfer files over the active SSH session; prefer files for multiple path pairs.",
      "Use timeout=0 unless the user requested a finite operation timeout. An explicit timeout closes the connection so an unknown remote command cannot corrupt the shared shell.",
    ],
    parameters: Parameters,
    exposure: "model-only",
    executionMode: "sequential",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validate(params);
      const connectionName = params.connection?.trim() || "default";
      let connection = connections.get(connectionName);
      const details: Details = {
        action: params.action,
        connection: params.connection ? connectionName : undefined,
        host: connection?.host,
        mode: connection?.mode,
      };
      const timeout = params.timeout && params.timeout > 0 ? params.timeout : undefined;

      if (params.action === "connect") {
        const target = params.host!.trim();
        const options = [...(params.options ?? [])];
        validateSSHOptions(options);
        const description = `${params.connection ? `Connection: ${JSON.stringify(connectionName)}\n` : ""}Host: ${JSON.stringify(target)}${options.length === 0 ? "" : `\nOptions: ${options.map((option) => JSON.stringify(option)).join(" ")}`}`;
        const requestedMode = await chooseConnectionMode(ctx, description);
        connection ??= createConnection(connectionName);
        try {
          await connection.session.connect(target, options, signal);
          connection.host = target;
          connection.mode = requestedMode;
          connections.set(connectionName, connection);
          details.host = target;
          details.mode = requestedMode;
          if (requestedMode === "yolo" && params.cacheSudoPassword) {
            let password: Buffer | null = null;
            try {
              password = await promptSudoPassword(ctx);
              if (password === null) throw new Error("Sudo authentication was cancelled.");
              await authenticateSudo(connection.session, password, timeout, signal);
              connection.cachedSudoPassword = password;
              password = null;
            } catch (error) {
              password?.fill(0);
              await connection.session.disconnect();
              throw error;
            }
          }
        } catch (error) {
          if (!connection.session.connected) connections.delete(connectionName);
          throw error;
        }
        const subject = params.connection ? `Connection ${JSON.stringify(connectionName)} connected to ${target}` : `Connected to ${target}`;
        const text = requestedMode === "yolo" ? `${subject} in YOLO mode.` : `${subject}.`;
        return { content: [{ type: "text" as const, text }], details };
      }

      if (params.action === "status") {
        if (params.connection) {
          const text = connection?.session.connected && connection.host && connection.mode
            ? `Connection ${JSON.stringify(connectionName)} is connected to ${connection.host} (${connection.mode === "yolo" ? "YOLO" : "prompt"} mode).`
            : `No active SSH session named ${JSON.stringify(connectionName)}.`;
          return { content: [{ type: "text" as const, text }], details };
        }
        const active = [...connections.entries()]
          .filter(([, item]) => item.session.connected && item.host && item.mode)
          .map(([name, item]) => ({ connection: name, host: item.host!, mode: item.mode! }));
        if (active.length === 0) {
          return { content: [{ type: "text" as const, text: "No active SSH session." }], details };
        }
        if (active.length === 1 && active[0].connection === "default") {
          const item = active[0];
          details.host = item.host;
          details.mode = item.mode;
          return {
            content: [{ type: "text" as const, text: `Connected to ${item.host} (${item.mode === "yolo" ? "YOLO" : "prompt"} mode).` }],
            details,
          };
        }
        details.connections = active;
        const text = `Active SSH sessions:\n${active.map((item) => `- ${item.connection}: ${item.host} (${item.mode === "yolo" ? "YOLO" : "prompt"} mode)`).join("\n")}`;
        return { content: [{ type: "text" as const, text }], details };
      }

      if (params.action === "disconnect") {
        const disconnectedHost = connection?.session.connected ? connection.host : undefined;
        await connection?.session.disconnect();
        connections.delete(connectionName);
        const text = disconnectedHost
          ? params.connection
            ? `Disconnected connection ${JSON.stringify(connectionName)} from ${disconnectedHost}.`
            : `Disconnected from ${disconnectedHost}.`
          : params.connection
            ? `No active SSH session named ${JSON.stringify(connectionName)}.`
            : "No active SSH session.";
        return {
          content: [{ type: "text" as const, text }],
          details: { action: params.action, connection: params.connection ? connectionName : undefined, host: disconnectedHost },
        };
      }

      if (!connection?.session.connected || !connection.host) {
        throw new Error(params.connection
          ? `No active SSH session named ${JSON.stringify(connectionName)}. Use action=connect first.`
          : "No active SSH session. Use action=connect first.");
      }
      const { session, host, mode: connectionMode } = connection;
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
            if (!connection.cachedSudoPassword) {
              throw new Error("Sudo authentication is required, but this YOLO connection has no cached sudo password.");
            }
            try {
              await authenticateSudo(session, connection.cachedSudoPassword, timeout, signal);
            } catch (error) {
              connection.cachedSudoPassword?.fill(0);
              connection.cachedSudoPassword = undefined;
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
      const connectionLabel = args.connection ? ` [${args.connection}]` : "";
      return new Text(theme.fg("toolTitle", theme.bold(`ssh${connectionLabel} ${args.action}${suffix}`)), 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
      const details = result.details as Details | undefined;
      const summary = details?.truncation?.truncated ? "Done (output truncated)" : "Done";
      return new Text(theme.fg("success", summary), 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...connections.values()].map(({ session }) => session.disconnect()));
    connections.clear();
  });
}

export { SSHSession, type CommandResult } from "./session.js";
