import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildContextHealthReport } from "./context-health.js";
import {
  createFingerprintStore,
  type FingerprintRecord,
} from "./fingerprints.js";
import { measureStaticBurden } from "./static-burden.js";
import {
  createContextThresholdState,
  shouldShowCompletionCheckpoint,
} from "./thresholds.js";
import { o200kEstimate } from "./tokenizer.js";
import {
  createUsageStore,
  parseUsageEvent,
  type UsageEvent,
} from "./usage.js";

export default function piAudit(pi: ExtensionAPI): void {
  let fingerprints = createFingerprintStore();
  const usage = createUsageStore();
  const thresholdState = createContextThresholdState();
  let currentMode: string | undefined;
  let mcpStatusSignature: string | undefined;
  let driftWarningsIgnored = false;
  let currentContext: ExtensionContext | undefined;
  let explicitRetryScheduled = false;
  let pendingCoreRetry = false;
  let coreRetryAttempt = 0;
  let activeCoreRetry:
    | { attempt: number; startedAt: number; model: string }
    | undefined;

  const rememberContext = (ctx: ExtensionContext): void => {
    currentContext = ctx;
  };

  const automaticNotice = (event: UsageEvent): void => {
    if (event.trigger !== "automatic" || !currentContext) return;
    const subject = event.retryLayer
      ? `${event.retryLayer} retry ${event.attempt ?? "?"}`
      : `${event.source} ${event.operation.replace(/-(start|complete|error)$/, "")}`;
    const verb =
      event.status === "start"
        ? "started"
        : event.status === "complete"
          ? "completed"
          : "failed";
    currentContext.ui.notify(
      `Automatic ${subject} ${verb} (${event.model})`,
      event.status === "error" ? "error" : "info",
    );
  };

  const recordUsage = (data: unknown): void => {
    const event = parseUsageEvent(data);
    if (!event) return;
    usage.record(event);
    automaticNotice(event);
  };

  pi.events.on("pi-audit:usage", recordUsage);
  pi.events.on("pi-audit:retry-scheduled", () => {
    explicitRetryScheduled = true;
    pendingCoreRetry = false;
  });

  pi.events.on("pi-modes:changed", (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const mode = (data as Record<string, unknown>).mode;
    if (typeof mode !== "string") return;
    currentMode = mode;
    fingerprints.expectTransition("mode-switch", mode);
  });

  pi.events.on("pi-mcp-adapter/status/v1", (data: unknown) => {
    const signature = JSON.stringify(data);
    if (
      mcpStatusSignature !== undefined &&
      mcpStatusSignature !== signature
    ) {
      fingerprints.expectTransition("mcp-change", currentMode);
    }
    mcpStatusSignature = signature;
  });

  pi.on("session_start", (event, ctx) => {
    rememberContext(ctx);
    thresholdState.reset();
    const restored = ctx.sessionManager.getBranch().flatMap((entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== "pi-audit:fingerprint"
      ) {
        return [];
      }
      return [entry.data as FingerprintRecord];
    });
    fingerprints = createFingerprintStore(restored);
    if (event.reason === "reload") {
      fingerprints.expectTransition("reload", currentMode);
    }
  });

  pi.on("resources_discover", (event) => {
    if (event.reason === "reload") {
      fingerprints.expectTransition("resource-change", currentMode);
    }
  });

  const notifyThresholdCrossings = (ctx: ExtensionContext) => {
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    for (const threshold of thresholdState.observe(tokens)) {
      ctx.ui.notify(
        `Context crossed ${threshold.toLocaleString()} tokens (${tokens.toLocaleString()} now). Consider /compact, /handoff, or /new.`,
        "warning",
      );
    }
  };

  pi.on("turn_end", (_event, ctx) => {
    notifyThresholdCrossings(ctx);
  });

  pi.on("session_compact", () => {
    thresholdState.reset();
  });

  pi.on("session_tree", () => {
    thresholdState.reset();
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "plan_tasks" || event.isError) return;
    const input = event.input as { action?: string };
    if (input.action !== "complete" && input.action !== "bulk-complete") return;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (!shouldShowCompletionCheckpoint(tokens)) return;
    ctx.ui.notify(
      `Task completed with ${tokens.toLocaleString()} context tokens retained. This is a good checkpoint for /compact, /handoff, or /new.`,
      "info",
    );
  });

  pi.on("before_agent_start", (event, ctx) => {
    rememberContext(ctx);
    const record = fingerprints.record({
      systemPrompt: event.systemPrompt,
      tools: pi.getAllTools(),
      activeToolNames: pi.getActiveTools(),
      mode: currentMode,
    });
    pi.appendEntry("pi-audit:fingerprint", record);
    if (record.classification === "unexpected" && !driftWarningsIgnored) {
      const changed = record.promptChanged
        ? record.toolsChanged
          ? "prompt/tool"
          : "prompt"
        : "tool";
      ctx.ui.notify(
        `Unexplained ${changed} fingerprint change (${record.likelySource})`,
        "warning",
      );
    }
  });

  const modelName = (ctx: ExtensionContext): string =>
    ctx.model?.provider && ctx.model?.id
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "unknown";

  const assistantUsage = (messages: unknown[]) => {
    const totals = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    };
    for (const message of messages) {
      if (
        !message ||
        typeof message !== "object" ||
        (message as { role?: unknown }).role !== "assistant"
      ) {
        continue;
      }
      const value = (message as { usage?: Partial<typeof totals> }).usage;
      totals.input += value?.input ?? 0;
      totals.cacheRead += value?.cacheRead ?? 0;
      totals.cacheWrite += value?.cacheWrite ?? 0;
      totals.output += value?.output ?? 0;
      totals.reasoning += value?.reasoning ?? 0;
    }
    return totals;
  };

  pi.on("agent_start", (_event, ctx) => {
    rememberContext(ctx);
    if (!pendingCoreRetry) return;
    pendingCoreRetry = false;
    coreRetryAttempt += 1;
    const model = modelName(ctx);
    activeCoreRetry = {
      attempt: coreRetryAttempt,
      startedAt: Date.now(),
      model,
    };
    recordUsage({
      source: "pi-core",
      operation: "retry-start",
      model,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      durationMs: 0,
      trigger: "automatic",
      status: "start",
      retryLayer: "core",
      attempt: coreRetryAttempt,
      route: model,
    });
  });

  pi.on("agent_end", (event, ctx) => {
    rememberContext(ctx);
    const messages = event.messages ?? [];
    const last = messages.at(-1) as
      | { role?: string; stopReason?: string }
      | undefined;
    if (activeCoreRetry) {
      const status = last?.stopReason === "error" ? "error" : "complete";
      recordUsage({
        source: "pi-core",
        operation: `retry-${status}`,
        model: activeCoreRetry.model,
        ...assistantUsage(messages),
        durationMs: Date.now() - activeCoreRetry.startedAt,
        trigger: "automatic",
        status,
        retryLayer: "core",
        attempt: activeCoreRetry.attempt,
        route: activeCoreRetry.model,
      });
      activeCoreRetry = undefined;
    }
    pendingCoreRetry =
      last?.role === "assistant" &&
      last.stopReason === "error" &&
      !explicitRetryScheduled;
    explicitRetryScheduled = false;
  });

  const onRuntimeEvent = pi.on as unknown as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => unknown,
  ) => void;
  onRuntimeEvent("agent_settled", (_event, ctx) => {
    rememberContext(ctx);
    pendingCoreRetry = false;
    explicitRetryScheduled = false;
    activeCoreRetry = undefined;
    coreRetryAttempt = 0;
  });

  pi.registerCommand("audit-baseline", {
    description: "Print prompt, skill, tool-schema, and custom-message burden",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
        buildContextEntries?: () => unknown[];
      };
      const branchEntries =
        sessionManager.buildContextEntries?.() ?? sessionManager.getBranch();
      const report = measureStaticBurden(
        {
          systemPrompt: ctx.getSystemPrompt(),
          skills: options.skills ?? [],
          tools: pi.getAllTools(),
          activeToolNames: pi.getActiveTools(),
          branchEntries,
        },
        o200kEstimate,
      );

      console.log(`PI_AUDIT_BASELINE=${JSON.stringify(report)}`);
      ctx.shutdown();
    },
  });

  pi.registerCommand("audit-fingerprints", {
    description: "Show prompt and active-tool fingerprint history",
    handler: async (_args, ctx) => {
      if (!fingerprints.report().current) {
        fingerprints.record({
          systemPrompt: ctx.getSystemPrompt(),
          tools: pi.getAllTools(),
          activeToolNames: pi.getActiveTools(),
          mode: currentMode,
        });
      }
      const report = fingerprints.report();
      console.log(`PI_AUDIT_FINGERPRINTS=${JSON.stringify(report)}`);
      ctx.ui.notify(JSON.stringify(report), "info");
    },
  });

  pi.registerCommand("context-health", {
    description: "Report retained context composition and cleanup options",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
        buildContextEntries?: () => unknown[];
      };
      const retainedEntries =
        sessionManager.buildContextEntries?.() ?? sessionManager.getBranch();
      const report = buildContextHealthReport(
        {
          contextTokens: ctx.getContextUsage()?.tokens ?? 0,
          staticBurden: {
            systemPrompt: ctx.getSystemPrompt(),
            skills: options.skills ?? [],
            tools: pi.getAllTools(),
            activeToolNames: pi.getActiveTools(),
            branchEntries: retainedEntries,
          },
          retainedEntries,
        },
        o200kEstimate,
      );
      console.log(`PI_CONTEXT_HEALTH=${JSON.stringify(report)}`);
      ctx.ui.notify(JSON.stringify(report), "info");
    },
  });

  pi.registerCommand("audit-ignore-drift", {
    description: "Ignore unexplained prompt/tool drift warnings for this session",
    handler: async (_args, ctx) => {
      driftWarningsIgnored = true;
      ctx.ui.notify("Prompt/tool drift warnings ignored for this session", "info");
    },
  });

  pi.registerCommand("audit-usage", {
    description: "Show extension-owned model usage breakdown",
    handler: async (_args, ctx) => {
      const report = usage.report();
      console.log(`PI_AUDIT_USAGE=${JSON.stringify(report)}`);
      ctx.ui.notify(JSON.stringify(report), "info");
    },
  });
}

export { buildContextHealthReport } from "./context-health.js";
export type {
  ContextHealthInput,
  ContextHealthReport,
} from "./context-health.js";
export { createFingerprintStore } from "./fingerprints.js";
export type {
  FingerprintInput,
  FingerprintRecord,
  FingerprintReport,
  FingerprintStore,
  FingerprintTool,
} from "./fingerprints.js";
export { measureStaticBurden } from "./static-burden.js";
export type {
  MeasuredValue,
  SkillInput,
  SourceInfoInput,
  StaticBurdenInput,
  StaticBurdenReport,
  TokenizerProvenance,
  ToolInput,
} from "./static-burden.js";
export { analyzeSessionJsonl } from "./session-usage.js";
export type {
  ContextGrowth,
  SessionUsageReport,
  UsageTotals,
  UserRunUsage,
} from "./session-usage.js";
export {
  CONTEXT_THRESHOLDS,
  createContextThresholdState,
  shouldShowCompletionCheckpoint,
} from "./thresholds.js";
export type { ContextThresholdState } from "./thresholds.js";
export { createUsageStore, parseUsageEvent } from "./usage.js";
export type {
  RetryLayer,
  UsageAggregate,
  UsageEvent,
  UsageReport,
  UsageStatus,
  UsageStore,
  UsageTrigger,
} from "./usage.js";
