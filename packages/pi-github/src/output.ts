import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { truncateText } from "./redaction.js";

export interface BoundedOutput {
  text: string;
  omittedItems: number;
  omittedBytes: number;
  fullOutputPath?: string;
}

interface BoundedOutputOptions {
  maxItems: number;
  maxBytes: number;
  persistDirectory?: string;
  filename?: string;
}

export async function formatBoundedList<T>(
  items: readonly T[],
  render: (item: T) => string,
  options: BoundedOutputOptions,
): Promise<BoundedOutput> {
  if (!Number.isInteger(options.maxItems) || options.maxItems < 0) {
    throw new Error("maxItems must be a non-negative integer.");
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative integer.");
  }

  const fullText = items.map(render).join("\n");
  const selected = items.slice(0, options.maxItems).map(render).join("\n");
  const bounded = truncateText(selected, options.maxBytes);
  let fullOutputPath: string | undefined;

  if (options.persistDirectory && (items.length > options.maxItems || bounded.truncated)) {
    await mkdir(options.persistDirectory, { recursive: true, mode: 0o700 });
    fullOutputPath = join(options.persistDirectory, basename(options.filename ?? "github-output.txt"));
    await writeFile(fullOutputPath, fullText, { encoding: "utf8", mode: 0o600 });
  }

  return {
    text: bounded.text,
    omittedItems: Math.max(0, items.length - options.maxItems),
    omittedBytes: Math.max(0, Buffer.byteLength(fullText) - Buffer.byteLength(bounded.text)),
    fullOutputPath,
  };
}

export function quoteUntrusted(value: string): string {
  return `--- BEGIN UNTRUSTED GITHUB CONTENT ---\n${value}\n--- END UNTRUSTED GITHUB CONTENT ---`;
}
