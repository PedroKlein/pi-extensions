export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface ContextGrowth {
  firstCallTokens: number;
  lastCallTokens: number;
  growthTokens: number;
  peakTokens: number;
}

export interface UserRunUsage {
  index: number;
  userEntryId: string;
  modelCallCount: number;
  usage: UsageTotals;
  context: ContextGrowth;
}

export interface SessionUsageReport {
  schemaVersion: 1;
  runs: UserRunUsage[];
  totals: UsageTotals & {
    userRunCount: number;
    modelCallCount: number;
  };
}

interface MutableRun {
  index: number;
  userEntryId: string;
  modelCallCount: number;
  usage: UsageTotals;
  contextTokens: number[];
}

const emptyUsage = (): UsageTotals => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finalize(run: MutableRun): UserRunUsage {
  const first = run.contextTokens[0] ?? 0;
  const last = run.contextTokens.at(-1) ?? 0;
  return {
    index: run.index,
    userEntryId: run.userEntryId,
    modelCallCount: run.modelCallCount,
    usage: { ...run.usage },
    context: {
      firstCallTokens: first,
      lastCallTokens: last,
      growthTokens: last - first,
      peakTokens: Math.max(0, ...run.contextTokens),
    },
  };
}

export function analyzeSessionJsonl(jsonl: string): SessionUsageReport {
  const runs: UserRunUsage[] = [];
  let current: MutableRun | undefined;

  for (const [lineIndex, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid session JSONL at line ${lineIndex + 1}: ${message}`);
    }
    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const normalized = message as Record<string, unknown>;

    if (normalized.role === "user") {
      if (current) runs.push(finalize(current));
      current = {
        index: runs.length + 1,
        userEntryId: typeof record.id === "string" ? record.id : "unknown",
        modelCallCount: 0,
        usage: emptyUsage(),
        contextTokens: [],
      };
      continue;
    }

    if (normalized.role !== "assistant" || !current) continue;
    current.modelCallCount += 1;
    const usage =
      normalized.usage && typeof normalized.usage === "object"
        ? (normalized.usage as Record<string, unknown>)
        : {};
    const input = numeric(usage.input);
    const cacheRead = numeric(usage.cacheRead);
    const cacheWrite = numeric(usage.cacheWrite);
    current.usage.input += input;
    current.usage.cacheRead += cacheRead;
    current.usage.cacheWrite += cacheWrite;
    current.usage.output += numeric(usage.output);
    current.usage.reasoning += numeric(usage.reasoning);
    current.contextTokens.push(input + cacheRead + cacheWrite);
  }

  if (current) runs.push(finalize(current));

  const usage = runs.reduce(
    (total, run) => ({
      input: total.input + run.usage.input,
      cacheRead: total.cacheRead + run.usage.cacheRead,
      cacheWrite: total.cacheWrite + run.usage.cacheWrite,
      output: total.output + run.usage.output,
      reasoning: total.reasoning + run.usage.reasoning,
    }),
    emptyUsage(),
  );

  return {
    schemaVersion: 1,
    runs,
    totals: {
      userRunCount: runs.length,
      modelCallCount: runs.reduce(
        (total, run) => total + run.modelCallCount,
        0,
      ),
      ...usage,
    },
  };
}
