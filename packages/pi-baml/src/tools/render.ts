/**
 * Shared rendering helpers for pi-baml tool display.
 *
 * Provides renderCall/renderResult implementations that produce
 * compact, colorized output using Pi's theme API.
 */

import type { BamlCallMetadata } from "../lib/types.js";

/** Minimal theme interface matching Pi's renderCall/renderResult theme arg. */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Truncate a string to maxLen, adding "…" if truncated. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format token counts into a compact string. */
function formatTokens(metadata: BamlCallMetadata): string {
  const parts: string[] = [];

  if (metadata.inputTokens !== null) {
    const cached = metadata.cachedInputTokens;
    if (cached !== null && cached > 0) {
      parts.push(`${metadata.inputTokens} in (${cached} cached)`);
    } else {
      parts.push(`${metadata.inputTokens} in`);
    }
  }

  if (metadata.outputTokens !== null) {
    parts.push(`${metadata.outputTokens} out`);
  }

  if (parts.length === 0) return "";
  return parts.join(" → ") + " tokens";
}

/**
 * Format a metadata footer line.
 * Example: "↳ github-copilot/claude-sonnet-4.6 (standard) • 245 in → 89 out tokens • 1.2s"
 */
export function formatMetadataFooter(
  metadata: BamlCallMetadata,
  theme: RenderTheme,
  tierSuffix: string = "",
): string {
  const segments: string[] = [];

  if (metadata.model) {
    segments.push(metadata.model + tierSuffix);
  } else if (tierSuffix) {
    segments.push(tierSuffix.trim());
  }

  const tokens = formatTokens(metadata);
  if (tokens) {
    segments.push(tokens);
  }

  if (metadata.durationMs !== null) {
    segments.push(formatDuration(metadata.durationMs));
  }

  if (segments.length === 0) return "";
  return theme.fg("muted", `↳ ${segments.join(" • ")}`);
}

/**
 * Pretty-print a JSON value with theme colors.
 * Keys in accent color, string values in toolOutput, numbers/booleans in warning.
 */
export function formatColoredJson(
  value: unknown,
  theme: RenderTheme,
  maxLines: number = 12,
): string {
  const json = JSON.stringify(value, null, 2);
  if (!json) return theme.fg("muted", "(no output)");

  const lines = json.split("\n");
  const display = lines.length > maxLines
    ? [...lines.slice(0, maxLines), theme.fg("muted", `... (${lines.length - maxLines} more lines)`)]
    : lines;

  return display
    .map((line) => colorizeJsonLine(line, theme))
    .join("\n");
}

/** Colorize a single JSON line. */
function colorizeJsonLine(line: string, theme: RenderTheme): string {
  // Match key-value pairs: "key": value
  const kvMatch = line.match(/^(\s*)"([^"]+)":\s*(.*)$/);
  if (kvMatch) {
    const [, indent, key, rest] = kvMatch;
    return `${indent}${theme.fg("accent", `"${key}"`)}: ${colorizeJsonValue(rest!, theme)}`;
  }

  // Standalone values (array items, etc.)
  return colorizeJsonValue(line, theme);
}

/** Colorize a JSON value portion. */
function colorizeJsonValue(value: string, theme: RenderTheme): string {
  const trimmed = value.trim();

  // String value
  if (trimmed.startsWith('"')) {
    // Truncate long strings in display
    const strMatch = trimmed.match(/^"(.*)"(,?)$/);
    if (strMatch) {
      const content = truncate(strMatch[1]!, 80);
      return value.replace(trimmed, theme.fg("toolOutput", `"${content}"`) + (strMatch[2] ?? ""));
    }
    return theme.fg("toolOutput", value);
  }

  // Numbers and booleans
  if (/^-?\d/.test(trimmed) || trimmed === "true," || trimmed === "false," ||
      trimmed === "true" || trimmed === "false" || trimmed === "null" || trimmed === "null,") {
    return theme.fg("warning", value);
  }

  // Structural chars ({, }, [, ])
  return theme.fg("muted", value);
}

/**
 * Render a compact call line for baml_exec.
 * Example: "baml_exec AnalyzeSentiment(text: "I absolutely lo…")"
 */
export function renderBamlExecCall(
  args: Record<string, unknown>,
  theme: RenderTheme,
): string {
  const functionName = typeof args["function"] === "string" ? args["function"] : "?";
  const functionArgs = args["args"] as Record<string, unknown> | undefined;
  const model = typeof args["model"] === "string" ? args["model"] : undefined;

  let argsPreview = "";
  if (functionArgs && typeof functionArgs === "object") {
    const entries = Object.entries(functionArgs);
    if (entries.length > 0) {
      const previews = entries.slice(0, 3).map(([k, v]) => {
        const val = typeof v === "string"
          ? `"${truncate(v, 30)}"`
          : JSON.stringify(v)?.slice(0, 30) ?? "…";
        return `${k}: ${val}`;
      });
      if (entries.length > 3) previews.push("…");
      argsPreview = `(${previews.join(", ")})`;
    }
  }

  const modelSuffix = model
    ? theme.fg("muted", ` (model: ${model})`)
    : "";

  return `${theme.fg("toolTitle", theme.bold("baml_exec"))} ${theme.fg("accent", functionName)}${theme.fg("muted", argsPreview)}${modelSuffix}`;
}

/**
 * Render a compact call line for baml_run.
 * Example: "baml_run ExtractEntities (model: claude-4.5-haiku)"
 */
export function renderBamlRunCall(
  args: Record<string, unknown>,
  theme: RenderTheme,
): string {
  const functionName = typeof args["function"] === "string" ? args["function"] : "?";
  const model = typeof args["model"] === "string" ? args["model"] : undefined;

  const modelSuffix = model
    ? theme.fg("muted", ` (model: ${model})`)
    : "";

  return `${theme.fg("toolTitle", theme.bold("baml_run"))} ${theme.fg("accent", functionName)}${modelSuffix}`;
}

/**
 * Render a compact call line for baml_list.
 * Example: "baml_list (group: "extraction")"
 */
export function renderBamlListCall(
  args: Record<string, unknown>,
  theme: RenderTheme,
): string {
  const group = typeof args["group"] === "string" ? args["group"] : undefined;

  const groupSuffix = group
    ? theme.fg("muted", ` (group: "${group}")`)
    : "";

  return `${theme.fg("toolTitle", theme.bold("baml_list"))}${groupSuffix}`;
}

/**
 * Render a baml_exec or baml_run result (pretty JSON + metadata footer).
 */
export function renderBamlResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: RenderTheme,
  isPartial?: boolean,
): string {
  if (isPartial) {
    return theme.fg("warning", "executing…");
  }

  const text = result.content?.[0]?.text ?? "";

  // Check if it's an error response
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return theme.fg("toolOutput", text || "(no output)");
  }

  // Check for BamlError shape
  if (isErrorResult(parsed)) {
    const err = parsed as { error: string; type: string };
    return theme.fg("error", `↳ error (${err.type}): ${err.error}`);
  }

  // Unwrap enriched result shape: { result, model, tier }
  let displayValue: unknown = parsed;
  let modelRef: string | null = null;
  let tier: string | null = null;
  if (isEnrichedResult(parsed)) {
    const enriched = parsed as { result: unknown; model: string; tier: string };
    displayValue = enriched.result;
    modelRef = enriched.model;
    tier = enriched.tier;
  }

  // Pretty-print the result
  const jsonOutput = formatColoredJson(displayValue, theme);

  // Extract metadata from details and enrich with model/tier from output
  const details = result.details as { metadata?: BamlCallMetadata } | undefined;
  const metadata = details?.metadata;

  // Build footer with model ref (prefer enriched model over collector's clientName)
  const footerMetadata: BamlCallMetadata = metadata
    ? { ...metadata, model: modelRef ?? metadata.model }
    : { inputTokens: null, outputTokens: null, cachedInputTokens: null, durationMs: null, model: modelRef };

  const tierSuffix = tier ? ` (${tier})` : "";
  const footer = formatMetadataFooter(footerMetadata, theme, tierSuffix);
  if (footer) {
    return `${jsonOutput}\n${footer}`;
  }

  return jsonOutput;
}

/**
 * Render baml_list result.
 */
export function renderBamlListResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: RenderTheme,
  isPartial?: boolean,
): string {
  if (isPartial) {
    return theme.fg("warning", "loading…");
  }

  const text = result.content?.[0]?.text ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return theme.fg("toolOutput", text || "(no output)");
  }

  // Check for message-only response (no functions found)
  if (isMessageResult(parsed)) {
    return theme.fg("muted", `↳ ${(parsed as { message: string }).message}`);
  }

  // Array of functions
  if (Array.isArray(parsed)) {
    const count = parsed.length;
    const groups = new Set(parsed.map((f: { group?: string }) => f.group).filter(Boolean));
    const summary = groups.size > 0
      ? `↳ ${count} function${count !== 1 ? "s" : ""} in ${groups.size} group${groups.size !== 1 ? "s" : ""}`
      : `↳ ${count} function${count !== 1 ? "s" : ""}`;

    // Show compact list
    const lines = parsed.slice(0, 10).map((f: { qualifiedName?: string; name?: string; outputType?: string }) => {
      const name = f.qualifiedName ?? f.name ?? "?";
      const output = f.outputType ? theme.fg("muted", ` → ${f.outputType}`) : "";
      return `  ${theme.fg("accent", name)}${output}`;
    });

    if (parsed.length > 10) {
      lines.push(theme.fg("muted", `  ... and ${parsed.length - 10} more`));
    }

    return `${theme.fg("muted", summary)}\n${lines.join("\n")}`;
  }

  return formatColoredJson(parsed, theme);
}

/** Type guard for error results. */
function isErrorResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["error"] === "string" && typeof obj["type"] === "string";
}

/** Type guard for enriched result shape: { result, model, tier }. */
function isEnrichedResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return "result" in obj && typeof obj["model"] === "string" && typeof obj["tier"] === "string";
}

/** Type guard for message-only results. */
function isMessageResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["message"] === "string" && Object.keys(obj).length === 1;
}
