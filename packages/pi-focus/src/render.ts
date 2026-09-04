import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { durationBand } from "./duration.js";
import type { FocusSnapshot, TelemetryTransition } from "./state.js";

export interface ExecutionView {
  label: string;
  elapsedMs: number;
  outputAgoMs?: number;
  possiblyStalled?: boolean;
  otherCount?: number;
}

export interface FocusRenderOptions {
  settled: boolean;
  execution?: ExecutionView;
  stale?: boolean;
}

type FocusColor = "accent" | "warning" | "error" | "success" | "muted" | "dim";

export interface FocusTheme {
  fg(color: FocusColor, text: string): string;
  bold(text: string): string;
}

const plainTheme: FocusTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

export function renderFocus(
  focus: FocusSnapshot,
  options: FocusRenderOptions,
  width: number,
  suppliedTheme?: Partial<FocusTheme>,
): string[] {
  const theme = isFocusTheme(suppliedTheme) ? suppliedTheme : plainTheme;
  const color = statusColor(focus, options.stale === true);
  const activityColor = focus.state === "active" && !options.stale ? "success" : color;
  const activityLabel = focus.state === "active"
    ? options.settled ? "LAST" : "NOW"
    : focus.state === "waiting" ? "WAIT" : focus.state === "blocked" ? "BLOCK" : "DONE";
  const activity = focus.now ?? focus.goal;
  const stale = options.stale
    ? theme.fg("warning", " · possibly stale")
    : "";
  const goalLine = railLine("FOCUS", theme.bold(focus.goal), "accent", theme);
  const badge = theme.fg(color, theme.bold(statusBadge(focus, options.stale === true)));
  const lines = [
    alignBadge(goalLine, badge, width),
    railLine(activityLabel, `${activity}${stale}`, activityColor, theme),
  ];
  if (focus.then) {
    lines.push(railLine("NEXT", focus.then, "muted", theme));
  }

  if (options.execution) {
    const execution = options.execution;
    const executionColor = execution.possiblyStalled ? "warning" : "accent";
    const metadata = [
      theme.fg("dim", formatElapsed(execution.elapsedMs)),
      focus.expectedDurationMs ? theme.fg("dim", `expected ${durationBand(focus.expectedDurationMs)}`) : undefined,
      execution.outputAgoMs === undefined ? undefined : theme.fg("dim", `output ${formatElapsed(execution.outputAgoMs)} ago`),
      execution.possiblyStalled ? theme.fg("warning", "possibly stalled") : undefined,
      execution.otherCount ? theme.fg("dim", `+${execution.otherCount} other tools`) : undefined,
    ].filter(Boolean).join(theme.fg("dim", " · "));
    lines.push(railLine(
      "RUN",
      `${theme.bold(execution.label)}${metadata ? `${theme.fg("dim", " · ")}${metadata}` : ""}`,
      executionColor,
      theme,
    ));
  }

  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function renderResumeCard(
  focus: FocusSnapshot,
  interrupted?: TelemetryTransition,
): string | null {
  if (focus.state === "done") return null;
  const lines = [
    `Resume · ${focus.goal}`,
    `Stopped at · ${focus.now ?? focus.goal}`,
  ];
  if (focus.then) lines.push(`Next · ${focus.then}`);
  if (interrupted?.expectedDurationMs) {
    lines.push(`Interrupted · ${interrupted.label} · expected ${durationBand(interrupted.expectedDurationMs)}`);
  }
  lines.push(`Updated · ${formatTimestamp(focus.updatedAt)}`);
  return lines.join("\n");
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${restSeconds ? `${restSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${restMinutes ? `${restMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `${days}d${restHours ? `${restHours}h` : ""}`;
}

function isFocusTheme(theme: Partial<FocusTheme> | undefined): theme is FocusTheme {
  return typeof theme?.fg === "function" && typeof theme.bold === "function";
}

function railLine(
  label: string,
  content: string,
  color: FocusColor,
  theme: FocusTheme,
): string {
  return `${theme.fg(color, "▌")} ${theme.fg(color, theme.bold(label.padEnd(5)))}  ${content}`;
}

function alignBadge(line: string, badge: string, width: number): string {
  const gap = width - visibleWidth(line) - visibleWidth(badge);
  if (gap < 2) return line;
  return `${line}${" ".repeat(gap)}${badge}`;
}

function statusColor(focus: FocusSnapshot, stale: boolean): FocusColor {
  if (stale) return "warning";
  if (focus.state === "waiting") return "warning";
  if (focus.state === "blocked") return "error";
  if (focus.state === "done") return "success";
  return "accent";
}

function statusBadge(focus: FocusSnapshot, stale: boolean): string {
  if (stale) return "STALE";
  return focus.state.toUpperCase();
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
