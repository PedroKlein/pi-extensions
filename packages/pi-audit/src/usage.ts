export type UsageTrigger = "automatic" | "user";
export type UsageStatus = "start" | "complete" | "error";
export type RetryLayer = "core" | "gateway" | "malformed-tool";

export interface UsageEvent {
  source: string;
  operation: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  durationMs: number;
  trigger: UsageTrigger;
  status: UsageStatus;
  retryLayer?: RetryLayer;
  attempt?: number;
  route?: string;
}

const usageNumbers = [
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "durationMs",
] as const;

export function parseUsageEvent(value: unknown): UsageEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (
    typeof event.source !== "string" ||
    typeof event.operation !== "string" ||
    typeof event.model !== "string" ||
    (event.trigger !== "automatic" && event.trigger !== "user") ||
    (event.status !== "start" &&
      event.status !== "complete" &&
      event.status !== "error") ||
    usageNumbers.some(
      (key) =>
        typeof event[key] !== "number" ||
        !Number.isFinite(event[key]) ||
        Number(event[key]) < 0,
    )
  ) {
    return undefined;
  }
  if (
    event.retryLayer !== undefined &&
    event.retryLayer !== "core" &&
    event.retryLayer !== "gateway" &&
    event.retryLayer !== "malformed-tool"
  ) {
    return undefined;
  }
  if (
    event.attempt !== undefined &&
    (typeof event.attempt !== "number" ||
      !Number.isInteger(event.attempt) ||
      event.attempt < 1)
  ) {
    return undefined;
  }
  if (event.route !== undefined && typeof event.route !== "string") {
    return undefined;
  }
  return { ...event } as unknown as UsageEvent;
}

export interface UsageAggregate {
  eventCount: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  durationMs: number;
}

export interface UsageReport {
  eventCount: number;
  totals: Omit<UsageAggregate, "eventCount">;
  bySource: Record<string, UsageAggregate>;
  events: UsageEvent[];
}

export interface UsageStore {
  record(event: UsageEvent): void;
  report(): UsageReport;
}

const emptyTotals = (): Omit<UsageAggregate, "eventCount"> => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  durationMs: 0,
});

function addUsage(
  total: Omit<UsageAggregate, "eventCount">,
  event: UsageEvent,
): void {
  total.input += event.input;
  total.cacheRead += event.cacheRead;
  total.cacheWrite += event.cacheWrite;
  total.output += event.output;
  total.reasoning += event.reasoning;
  total.durationMs += event.durationMs;
}

export function createUsageStore(): UsageStore {
  const events: UsageEvent[] = [];

  return {
    record(event) {
      events.push({ ...event });
    },
    report() {
      const totals = emptyTotals();
      const bySource: Record<string, UsageAggregate> = {};

      for (const event of events) {
        addUsage(totals, event);
        const source = bySource[event.source] ?? {
          eventCount: 0,
          ...emptyTotals(),
        };
        source.eventCount += 1;
        addUsage(source, event);
        bySource[event.source] = source;
      }

      return {
        eventCount: events.length,
        totals,
        bySource,
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}
