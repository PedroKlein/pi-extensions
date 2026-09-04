export const FOCUS_ENTRY_TYPE = "pi-focus";
export const FOCUS_TELEMETRY_ENTRY_TYPE = "pi-focus-telemetry";
const VERSION = 1;
const states = ["active", "waiting", "blocked", "done"] as const;

export type FocusStatus = (typeof states)[number];
export type FocusSource = "agent" | "user";

export interface FocusSnapshot {
  goal: string;
  now?: string;
  then?: string;
  state: FocusStatus;
  expectedDurationMs?: number;
  handoff?: string;
  updatedAt: number;
}

export interface FocusUpdate {
  goal?: string;
  now?: string | null;
  then?: string | null;
  state?: FocusStatus;
  expectedDurationMs?: number | null;
  handoff?: string | null;
}

export interface FocusUpdateTransition {
  version: 1;
  kind: "update";
  source: FocusSource;
  snapshot: FocusSnapshot;
}

export interface FocusClearTransition {
  version: 1;
  kind: "clear";
  source: "user";
  updatedAt: number;
}

export type FocusTransition = FocusUpdateTransition | FocusClearTransition;

export interface FocusReplay {
  current: FocusSnapshot | null;
  transitions: FocusTransition[];
}

export type TelemetryKind = "execution-start" | "execution-end" | "stall" | "failure" | "abort" | "waiting";

export interface TelemetryTransition {
  version: 1;
  kind: TelemetryKind;
  id: string;
  toolName: string;
  label: string;
  at: number;
  expectedDurationMs?: number;
}

export interface TelemetryReplay {
  events: TelemetryTransition[];
  interrupted: TelemetryTransition[];
}

export function createFocusTransition(
  current: FocusSnapshot | null,
  update: FocusUpdate,
  source: FocusSource,
  updatedAt = Date.now(),
): FocusUpdateTransition {
  const goal = cleanText(update.goal) ?? current?.goal;
  if (!goal) throw new Error("goal is required for the first focus update");

  const snapshot: FocusSnapshot = {
    goal,
    state: update.state ?? current?.state ?? "active",
    updatedAt,
  };
  assignOptional(snapshot, "now", update.now, current?.now);
  assignOptional(snapshot, "then", update.then, current?.then);
  assignOptional(snapshot, "handoff", update.handoff, current?.handoff);
  assignOptional(snapshot, "expectedDurationMs", update.expectedDurationMs, current?.expectedDurationMs);

  if (!isSnapshot(snapshot)) throw new Error("invalid focus update");
  return { version: VERSION, kind: "update", source, snapshot };
}

export function createClearTransition(updatedAt = Date.now()): FocusClearTransition {
  return { version: VERSION, kind: "clear", source: "user", updatedAt };
}

export function createTelemetryTransition(
  kind: TelemetryKind,
  execution: { id: string; toolName: string; label: string; expectedDurationMs?: number },
  at = Date.now(),
): TelemetryTransition {
  const transition: TelemetryTransition = {
    version: VERSION,
    kind,
    id: execution.id,
    toolName: execution.toolName,
    label: normalizeTelemetryLabel(execution.label, execution.toolName),
    at,
    ...(execution.expectedDurationMs ? { expectedDurationMs: execution.expectedDurationMs } : {}),
  };
  if (!isTelemetryTransition(transition)) throw new Error("invalid telemetry transition");
  return transition;
}

export function normalizeTelemetryLabel(label: string, fallback: string): string {
  const normalized = label.trim().replace(/\s+/g, " ");
  return (normalized || fallback).slice(0, 120);
}

export function replayTelemetryEntries(entries: readonly unknown[]): TelemetryReplay {
  const events: TelemetryTransition[] = [];
  const active = new Map<string, TelemetryTransition>();
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.type !== "custom" || entry.customType !== FOCUS_TELEMETRY_ENTRY_TYPE) continue;
    if (!isTelemetryTransition(entry.data)) continue;
    const transition = entry.data;
    events.push(transition);
    if (transition.kind === "execution-start") active.set(transition.id, transition);
    if (["execution-end", "failure", "abort"].includes(transition.kind)) active.delete(transition.id);
  }
  return { events, interrupted: [...active.values()].sort((a, b) => a.at - b.at) };
}

export function replayFocusEntries(entries: readonly unknown[]): FocusReplay {
  const transitions: FocusTransition[] = [];
  let current: FocusSnapshot | null = null;

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.type !== "custom" || entry.customType !== FOCUS_ENTRY_TYPE) continue;
    const transition = parseTransition(entry.data);
    if (!transition) continue;
    transitions.push(transition);
    current = transition.kind === "clear" ? null : transition.snapshot;
  }

  return { current, transitions };
}

function assignOptional<T extends FocusSnapshot, K extends "now" | "then" | "handoff" | "expectedDurationMs">(
  target: T,
  key: K,
  update: FocusUpdate[K],
  current: FocusSnapshot[K],
): void {
  const value = update === undefined ? current : update;
  if (typeof value === "string") {
    const text = cleanText(value);
    if (text) target[key] = text as T[K];
  } else if (value !== undefined && value !== null) {
    target[key] = value as T[K];
  }
}

function parseTransition(value: unknown): FocusTransition | null {
  const transition = asRecord(value);
  if (!transition || transition.version !== VERSION) return null;
  if (transition.kind === "clear") {
    return transition.source === "user" && isTimestamp(transition.updatedAt)
      ? transition as unknown as FocusClearTransition
      : null;
  }
  if (
    transition.kind !== "update" ||
    (transition.source !== "agent" && transition.source !== "user") ||
    !isSnapshot(transition.snapshot)
  ) return null;
  return transition as unknown as FocusUpdateTransition;
}

function isTelemetryTransition(value: unknown): value is TelemetryTransition {
  const transition = asRecord(value);
  if (!transition || transition.version !== VERSION) return false;
  if (!["execution-start", "execution-end", "stall", "failure", "abort", "waiting"].includes(String(transition.kind))) return false;
  if (!isBoundedText(transition.id, 200) || !isBoundedText(transition.toolName, 100) || !isBoundedText(transition.label, 120)) return false;
  if (!isTimestamp(transition.at)) return false;
  return transition.expectedDurationMs === undefined || (
    Number.isSafeInteger(transition.expectedDurationMs) && Number(transition.expectedDurationMs) > 0
  );
}

function isSnapshot(value: unknown): value is FocusSnapshot {
  const snapshot = asRecord(value);
  if (!snapshot || !isText(snapshot.goal) || !states.includes(snapshot.state as FocusStatus)) return false;
  if (!isTimestamp(snapshot.updatedAt)) return false;
  if (!isOptionalText(snapshot.now) || !isOptionalText(snapshot.then) || !isOptionalText(snapshot.handoff)) return false;
  return snapshot.expectedDurationMs === undefined || (
    Number.isSafeInteger(snapshot.expectedDurationMs) && Number(snapshot.expectedDurationMs) > 0
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value);
}

function isText(value: unknown): value is string {
  return isBoundedText(value, 500);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 500) throw new Error("focus text must be 500 characters or fewer");
  return text;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
