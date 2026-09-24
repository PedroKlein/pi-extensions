import { readFile, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SSHSession } from "./session.js";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.message : String(error);
}

export async function upload(
  session: SSHSession,
  localPath: string,
  remotePath: string,
  timeout?: number,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  let bytes: Buffer;
  try {
    bytes = await readFile(localPath);
  } catch (error) {
    throw new Error(`Failed to read local file ${JSON.stringify(localPath)}: ${errorMessage(error)}`);
  }

  const result = await session.executeWithInputLine(
    `IFS= read -r __pi_transfer_data; printf '%s' "$__pi_transfer_data" | base64 -d > ${shellQuote(remotePath)}; __pi_transfer_ec=$?; unset __pi_transfer_data; (exit "$__pi_transfer_ec")`,
    bytes.toString("base64"),
    timeout,
    signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to upload to ${JSON.stringify(remotePath)}: remote command exited with code ${result.exitCode}.`);
  }
  return bytes.length;
}

export async function download(
  session: SSHSession,
  remotePath: string,
  localPath: string,
  timeout?: number,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const result = await session.execute(`base64 < ${shellQuote(remotePath)}`, timeout, signal);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to download ${JSON.stringify(remotePath)}: remote command exited with code ${result.exitCode}.`);
  }

  const encoded = result.output.replaceAll(/\s/g, "");
  const padding = encoded.indexOf("=");
  const validPadding = padding < 0
    || padding === encoded.length - 1
    || (padding === encoded.length - 2 && encoded.endsWith("=="));
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || !validPadding) {
    throw new Error(`Failed to download ${JSON.stringify(remotePath)}: remote output was not valid base64.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  try {
    await withFileMutationQueue(localPath, async () => {
      signal?.throwIfAborted();
      await writeFile(localPath, bytes);
    });
  } catch (error) {
    throw new Error(`Failed to write local file ${JSON.stringify(localPath)}: ${errorMessage(error)}`);
  }
  return bytes.length;
}
