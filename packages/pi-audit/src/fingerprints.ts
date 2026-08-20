import { createHash } from "node:crypto";

export interface FingerprintTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface FingerprintInput {
  systemPrompt: string;
  tools: FingerprintTool[];
  activeToolNames: string[];
  mode?: string;
}

export type ExpectedTransitionSource =
  | "mode-switch"
  | "mcp-change"
  | "reload"
  | "resource-change";

export type FingerprintClassification =
  | "initial"
  | "unchanged"
  | "expected"
  | "unexpected";

export interface FingerprintRecord {
  sequence: number;
  promptHash: string;
  toolHash: string;
  promptChanged: boolean;
  toolsChanged: boolean;
  classification: FingerprintClassification;
  likelySource: string;
  mode: string | null;
}

export interface FingerprintReport {
  current: FingerprintRecord | null;
  previous: FingerprintRecord | null;
  history: FingerprintRecord[];
}

export interface FingerprintStore {
  expectTransition(source: ExpectedTransitionSource, mode?: string): void;
  record(input: FingerprintInput): FingerprintRecord;
  report(): FingerprintReport;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) sorted[key] = canonicalize(record[key]);
  }
  return sorted;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolPayload(input: FingerprintInput): string {
  const active = new Set(input.activeToolNames);
  const tools = input.tools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalize(tool.parameters),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(tools);
}

export function createFingerprintStore(
  initialHistory: FingerprintRecord[] = [],
): FingerprintStore {
  const history: FingerprintRecord[] = initialHistory.map((record) => ({
    ...record,
  }));
  let expected:
    | { source: ExpectedTransitionSource; mode: string | null }
    | undefined;

  return {
    expectTransition(source, mode) {
      expected = { source, mode: mode ?? null };
    },
    record(input) {
      const previous = history.at(-1);
      const promptHash = hash(input.systemPrompt);
      const toolHash = hash(toolPayload(input));
      const promptChanged = previous ? previous.promptHash !== promptHash : false;
      const toolsChanged = previous ? previous.toolHash !== toolHash : false;
      const changed = promptChanged || toolsChanged;

      let classification: FingerprintClassification = "initial";
      let likelySource = "initial";
      if (previous && !changed) {
        classification = "unchanged";
        likelySource = "unchanged";
      } else if (previous && expected) {
        classification = "expected";
        likelySource = expected.source;
      } else if (previous) {
        classification = "unexpected";
        likelySource = promptChanged
          ? toolsChanged
            ? "prompt-and-tools"
            : "prompt"
          : "active-tools";
      }

      const record: FingerprintRecord = {
        sequence: history.length + 1,
        promptHash,
        toolHash,
        promptChanged,
        toolsChanged,
        classification,
        likelySource,
        mode: input.mode ?? expected?.mode ?? previous?.mode ?? null,
      };
      history.push(record);
      expected = undefined;
      return { ...record };
    },
    report() {
      const current = history.at(-1);
      const previous = history.at(-2);
      return {
        current: current ? { ...current } : null,
        previous: previous ? { ...previous } : null,
        history: history.map((record) => ({ ...record })),
      };
    },
  };
}
