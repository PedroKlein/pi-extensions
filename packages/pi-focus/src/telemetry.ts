import type { ExecutionView } from "./render.js";
import { normalizeTelemetryLabel } from "./state.js";

export interface ActiveExecution {
  id: string;
  toolName: string;
  label: string;
  startedAt: number;
  lastOutputAt: number;
  expectedDurationMs?: number;
  possiblyStalled?: boolean;
  stallNotified?: boolean;
}

export class TelemetryTracker {
  private readonly executions = new Map<string, ActiveExecution>();

  constructor(private readonly now: () => number = Date.now) {}

  start(id: string, toolName: string, label: string, expectedDurationMs?: number): void {
    const startedAt = this.now();
    this.executions.set(id, {
      id,
      toolName,
      label: normalizeTelemetryLabel(label, toolName),
      startedAt,
      lastOutputAt: startedAt,
      ...(expectedDurationMs ? { expectedDurationMs } : {}),
    });
  }

  update(id: string): void {
    const execution = this.executions.get(id);
    if (execution) execution.lastOutputAt = this.now();
  }

  end(id: string): ActiveExecution | undefined {
    const execution = this.executions.get(id);
    this.executions.delete(id);
    return execution;
  }

  markPossiblyStalled(id: string): void {
    const execution = this.executions.get(id);
    if (execution) execution.possiblyStalled = true;
  }

  detectNewStalls(): ActiveExecution[] {
    const now = this.now();
    const stalled: ActiveExecution[] = [];
    for (const execution of this.executions.values()) {
      if (!execution.expectedDurationMs || execution.possiblyStalled) continue;
      const thresholds = stallThresholds(execution.expectedDurationMs);
      if (
        now - execution.startedAt >= thresholds.elapsedMs &&
        now - execution.lastOutputAt >= thresholds.silenceMs
      ) {
        execution.possiblyStalled = true;
        stalled.push({ ...execution });
      }
    }
    return stalled;
  }

  clear(): void {
    this.executions.clear();
  }

  active(): ActiveExecution[] {
    return [...this.executions.values()].map((execution) => ({ ...execution }));
  }

  view(): ExecutionView | undefined {
    const active = this.active();
    if (!active.length) return undefined;
    active.sort((left, right) => priority(right) - priority(left) || left.startedAt - right.startedAt);
    const selected = active[0];
    const subagentCount = active.filter((execution) => execution.toolName === "subagent").length;
    const selectedAggregatesSubagents = selected.toolName === "subagent" && subagentCount > 1;
    return {
      label: selectedAggregatesSubagents ? `subagents (${subagentCount})` : selected.label,
      elapsedMs: Math.max(0, this.now() - selected.startedAt),
      outputAgoMs: Math.max(0, this.now() - selected.lastOutputAt),
      possiblyStalled: selected.possiblyStalled,
      otherCount: selectedAggregatesSubagents ? active.length - subagentCount : active.length - 1,
    };
  }
}

export function stallThresholds(expectedDurationMs: number): { elapsedMs: number; silenceMs: number } {
  if (!Number.isSafeInteger(expectedDurationMs) || expectedDurationMs <= 0) {
    throw new Error("expected duration must be a positive safe integer");
  }
  return {
    elapsedMs: Math.max(120_000, Math.min(Number.MAX_SAFE_INTEGER, expectedDurationMs * 2)),
    silenceMs: Math.min(24 * 3_600_000, Math.max(30_000, Math.floor(expectedDurationMs / 6))),
  };
}

function priority(execution: ActiveExecution): number {
  if (execution.possiblyStalled) return 2;
  if (execution.expectedDurationMs) return 1;
  return 0;
}
