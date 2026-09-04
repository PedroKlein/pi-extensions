import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { durationBand, formatDurationInput, parseDuration } from "./duration.js";
import { FreshnessTracker } from "./freshness.js";
import { renderFocus, renderResumeCard } from "./render.js";
import { TelemetryTracker } from "./telemetry.js";
import {
  FOCUS_ENTRY_TYPE,
  FOCUS_TELEMETRY_ENTRY_TYPE,
  createClearTransition,
  createFocusTransition,
  createTelemetryTransition,
  replayFocusEntries,
  replayTelemetryEntries,
  type FocusSnapshot,
  type FocusStatus,
  type FocusTransition,
  type FocusUpdate,
  type TelemetryTransition,
} from "./state.js";

const nullableText = Type.Union([Type.String({ maxLength: 500 }), Type.Null()]);

export default function piFocus(pi: ExtensionAPI): void {
  let current: FocusSnapshot | null = null;
  let transitions: FocusTransition[] = [];
  let latestCtx: ExtensionContext | null = null;
  let settled = true;
  let resumeShown = false;
  let interrupted: TelemetryTransition | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const telemetry = new TelemetryTracker();
  const freshness = new FreshnessTracker();

  function refreshWidget(): void {
    if (!latestCtx) return;
    if (!current) {
      latestCtx.ui.setWidget("pi-focus", undefined);
      return;
    }
    latestCtx.ui.setWidget("pi-focus", (_tui, theme) => ({
      render: (width: number) => renderFocus(current!, {
        settled,
        execution: telemetry.view(),
        stale: current!.state === "active" && freshness.stale,
      }, width, theme),
      invalidate: () => {},
    }), { placement: "belowEditor" });
  }

  function persist(transition: FocusTransition): void {
    pi.appendEntry(FOCUS_ENTRY_TYPE, transition);
    transitions.push(transition);
    current = transition.kind === "clear" ? null : transition.snapshot;
    freshness.reset();
    refreshWidget();
  }

  function persistTelemetry(transition: TelemetryTransition): void {
    pi.appendEntry(FOCUS_TELEMETRY_ENTRY_TYPE, transition);
  }

  function monitorExecutions(): void {
    for (const execution of telemetry.detectNewStalls()) {
      persistTelemetry(createTelemetryTransition("stall", execution));
      latestCtx?.ui.notify(`${execution.label} is possibly stalled.`, "warning");
    }
    refreshWidget();
  }

  function restoreBranch(ctx: ExtensionContext): void {
    latestCtx = ctx;
    telemetry.clear();
    freshness.reset();
    const branch = ctx.sessionManager.getBranch();
    const replay = replayFocusEntries(branch);
    const telemetryReplay = replayTelemetryEntries(branch);
    current = replay.current;
    transitions = replay.transitions;
    interrupted = telemetryReplay.interrupted.at(-1);
    refreshWidget();
  }

  pi.registerTool({
    name: "focus_update",
    label: "Focus Update",
    description: "Publish a concise public progress update containing the current goal and activity. Semantic intent must be supplied explicitly.",
    promptSnippet: "Publish the current Goal, Now, optional Then, state, expected duration, or handoff",
    promptGuidelines: [
      "Use focus_update when beginning substantive work or when the user explicitly requests persistent focus tracking.",
      "Before focus_update, ask for clarification when a consequential goal is unclear.",
      "Call focus_update when establishing a goal, detouring, starting expected-long work, waiting or blocked, returning from a detour, and completing or handing off.",
      "Keep focus_update text concise and suitable as a public progress note; provide a realistic expected_duration for expected-long work.",
    ],
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ maxLength: 500, description: "Overall outcome; required on the first update" })),
      now: Type.Optional(nullableText),
      then: Type.Optional(nullableText),
      state: Type.Optional(Type.Union([
        Type.Literal("active"),
        Type.Literal("waiting"),
        Type.Literal("blocked"),
        Type.Literal("done"),
      ])),
      expected_duration: Type.Optional(Type.Union([
        Type.String({ description: "Positive duration such as 45m, 3h, 2d, or 1.5w" }),
        Type.Null(),
      ])),
      handoff: Type.Optional(nullableText),
    }),
    async execute(toolCallId, params) {
      const update: FocusUpdate = {
        goal: params.goal,
        now: params.now,
        then: params.then,
        state: params.state,
        handoff: params.handoff,
        expectedDurationMs: params.expected_duration === undefined
          ? undefined
          : params.expected_duration === null
            ? null
            : parseDuration(params.expected_duration),
      };
      const transition = createFocusTransition(current, update, "agent");
      persist(transition);
      if (transition.snapshot.state === "waiting") {
        persistTelemetry(createTelemetryTransition("waiting", {
          id: toolCallId,
          toolName: "focus_update",
          label: transition.snapshot.now ?? transition.snapshot.goal,
          expectedDurationMs: transition.snapshot.expectedDurationMs,
        }));
      }
      const expected = transition.snapshot.expectedDurationMs
        ? ` · expected ${durationBand(transition.snapshot.expectedDurationMs)}`
        : "";
      return {
        content: [{ type: "text", text: `Focus updated: ${transition.snapshot.now ?? transition.snapshot.goal}${expected}` }],
        details: { focus: transition.snapshot },
      };
    },
  });

  pi.registerCommand("focus", {
    description: "Inspect, edit, or clear persistent focus",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        ctx.ui.notify(formatFocus(current, transitions), "info");
        return;
      }
      if (action === "edit") {
        await editFocus(ctx);
        return;
      }
      if (action === "clear") {
        if (!current) {
          ctx.ui.notify("No focus to clear.", "info");
          return;
        }
        if (await ctx.ui.confirm("Clear focus?", "This stops displaying the current focus.")) {
          persist(createClearTransition());
          ctx.ui.notify("Focus cleared.", "info");
        }
        return;
      }
      ctx.ui.notify("Usage: /focus, /focus edit, or /focus clear", "warning");
    },
  });

  async function editFocus(ctx: ExtensionContext): Promise<void> {
    const edited = await ctx.ui.editor("Edit focus", focusEditorText(current));
    if (edited === undefined) return;
    try {
      persist(createFocusTransition(current, parseFocusEditor(edited), "user"));
      ctx.ui.notify("Focus updated.", "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Invalid focus", "error");
    }
  }

  pi.on("session_start", (event, ctx) => {
    settled = true;
    restoreBranch(ctx);
    if (!refreshTimer) {
      refreshTimer = setInterval(monitorExecutions, 5_000);
      refreshTimer.unref?.();
    }
    if (!resumeShown && event.reason === "resume" && current) {
      const card = renderResumeCard(current, interrupted);
      if (card) {
        resumeShown = true;
        ctx.ui.notify(card, "info");
      }
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    settled = true;
    restoreBranch(ctx);
  });

  pi.on("agent_start", () => {
    settled = false;
    refreshWidget();
  });

  const onRuntimeEvent = pi.on as unknown as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => unknown,
  ) => void;
  onRuntimeEvent("agent_settled", () => {
    settled = true;
    refreshWidget();
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "focus_update") return;
    const expectedDurationMs = current?.state === "active" ? current.expectedDurationMs : undefined;
    const label = expectedDurationMs && current?.now ? current.now : event.toolName;
    telemetry.start(event.toolCallId, event.toolName, label, expectedDurationMs);
    if (expectedDurationMs) {
      persistTelemetry(createTelemetryTransition("execution-start", {
        id: event.toolCallId,
        toolName: event.toolName,
        label,
        expectedDurationMs,
      }));
    }
    refreshWidget();
  });

  pi.on("tool_execution_update", (event) => {
    telemetry.update(event.toolCallId);
    refreshWidget();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const execution = telemetry.end(event.toolCallId);
    if (execution && (execution.expectedDurationMs || event.isError)) {
      const kind = event.isError ? ctx.signal?.aborted ? "abort" : "failure" : "execution-end";
      persistTelemetry(createTelemetryTransition(kind, execution));
    }
    if (current?.state === "active") freshness.completeTool(event.toolName);
    refreshWidget();
  });

  pi.on("turn_end", () => {
    if (current?.state === "active") freshness.completeTurn();
    refreshWidget();
  });

  pi.on("before_agent_start", () => {
    if (current?.state !== "active" || !freshness.takeReminder()) return;
    return {
      message: {
        customType: "pi-focus-reminder",
        content: "Focus may be stale. Call focus_update to refresh or reaffirm the public Goal, Now, and Then.",
        display: false,
      },
    };
  });

  pi.on("context", (event) => ({
    messages: event.messages.filter((message) =>
      !(message.role === "custom" && message.customType === "pi-focus-reminder"),
    ),
  }));

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}

function formatFocus(current: FocusSnapshot | null, transitions: readonly FocusTransition[]): string {
  if (!current) return "No focus is active.";
  const lines = [
    `Goal: ${current.goal}`,
    current.now ? `Now: ${current.now}` : undefined,
    current.then ? `Then: ${current.then}` : undefined,
    `State: ${current.state}`,
    current.expectedDurationMs ? `Expected: ${durationBand(current.expectedDurationMs)}` : undefined,
  ].filter(Boolean) as string[];
  const recent = transitions.slice(-3).map((transition) =>
    transition.kind === "clear"
      ? "- cleared"
      : `- ${transition.snapshot.state}: ${transition.snapshot.now ?? transition.snapshot.goal}`,
  );
  if (recent.length) lines.push("Recent:", ...recent);
  return lines.join("\n");
}

function focusEditorText(current: FocusSnapshot | null): string {
  return [
    `Goal: ${current?.goal ?? ""}`,
    `Now: ${current?.now ?? ""}`,
    `Then: ${current?.then ?? ""}`,
    `State: ${current?.state ?? "active"}`,
    `Expected: ${current?.expectedDurationMs ? formatDurationInput(current.expectedDurationMs) : ""}`,
    `Handoff: ${current?.handoff ?? ""}`,
  ].join("\n");
}

function parseFocusEditor(text: string): FocusUpdate {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const status = values.get("state") || "active";
  if (!["active", "waiting", "blocked", "done"].includes(status)) {
    throw new Error("State must be active, waiting, blocked, or done");
  }
  const expected = values.get("expected") ?? "";
  return {
    goal: values.get("goal"),
    now: values.get("now") || null,
    then: values.get("then") || null,
    state: status as FocusStatus,
    expectedDurationMs: expected ? parseDuration(expected) : null,
    handoff: values.get("handoff") || null,
  };
}
