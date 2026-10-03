import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  aggregateChecks,
  waitForChecks,
  type CheckSource,
  type ChecksSnapshot,
} from "./checks.js";

const MAX_CHECKS = 20;

const Parameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("diagnose")]),
  sha: Type.String({ description: "Exact 40-character commit SHA" }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000, description: "Wait timeout in milliseconds" })),
  allowNoChecks: Type.Optional(Type.Boolean({ description: "Treat no discovered checks as success; default false" })),
});

type Parameters = {
  action: "status" | "wait" | "diagnose";
  sha: string;
  timeoutMs?: number;
  allowNoChecks?: boolean;
};

interface RegistrationOptions {
  pollIntervalMs?: number;
  heartbeatMs?: number;
  onProgress?: (snapshot: ChecksSnapshot | null) => void;
}

interface ChecksDetails extends Omit<ChecksSnapshot, "checks" | "pending" | "failed" | "cancelled"> {
  checks: ChecksSnapshot["checks"];
  pending: ChecksSnapshot["pending"];
  failed: ChecksSnapshot["failed"];
  cancelled: ChecksSnapshot["cancelled"];
  omittedChecks: number;
}

export function registerGitHubChecks(
  pi: ExtensionAPI,
  source: CheckSource,
  options: RegistrationOptions = {},
): void {
  pi.registerTool({
    name: "github_checks",
    label: "GitHub checks",
    description: "Read or wait for GitHub checks bound to an exact commit SHA. Waits are cancellable and publish compact replaceable progress snapshots without logs.",
    promptSnippet: "Read or wait for GitHub CI checks without shell polling",
    promptGuidelines: [
      "Use github_checks wait instead of repeated shell polling while GitHub CI runs.",
      "Do not use Bash sleep loops to wait for GitHub checks.",
      "Treat no-checks as distinct from success unless the user explicitly allowed no-check merges.",
      "Use the separate diagnosis action after failure; waiting never streams raw logs.",
    ],
    parameters: Parameters,
    exposure: "direct",
    executionMode: "sequential",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async execute(_toolCallId, params: Parameters, signal, onUpdate) {
      requireParameters(params);
      let snapshot: ChecksSnapshot;
      if (params.action === "diagnose") {
        if (!source.diagnose) throw new Error("Failure diagnosis is unavailable.");
        const diagnosis = await source.diagnose(params.sha, signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(diagnosis, null, 2) }],
          details: diagnosis,
        };
      }
      if (params.action === "status") {
        snapshot = aggregateChecks(await source.observe(params.sha, signal));
      } else {
        snapshot = await waitForChecks(
          (activeSignal) => source.observe(params.sha, activeSignal),
          {
            sha: params.sha,
            timeoutMs: params.timeoutMs ?? 30 * 60_000,
            pollIntervalMs: options.pollIntervalMs,
            heartbeatMs: options.heartbeatMs,
            allowNoChecks: params.allowNoChecks ?? false,
            signal,
            onUpdate: (next) => {
              options.onProgress?.(next);
              publish(onUpdate, next);
            },
          },
        );
        options.onProgress?.(null);
      }
      const details = boundSnapshot(snapshot);
      return {
        content: [{ type: "text" as const, text: renderSnapshot(details) }],
        details,
      };
    },
  });
}

function publish(
  onUpdate: AgentToolUpdateCallback<ChecksDetails> | undefined,
  snapshot: ChecksSnapshot,
): void {
  const details = boundSnapshot(snapshot);
  onUpdate?.({
    content: [{ type: "text", text: renderSnapshot(details) }],
    details,
  });
}

function boundSnapshot(snapshot: ChecksSnapshot): ChecksDetails {
  const checks = snapshot.checks.slice(0, MAX_CHECKS);
  const allowedIds = new Set(checks.map((check) => check.id));
  return {
    ...snapshot,
    checks,
    pending: snapshot.pending.filter((check) => allowedIds.has(check.id)),
    failed: snapshot.failed.filter((check) => allowedIds.has(check.id)),
    cancelled: snapshot.cancelled.filter((check) => allowedIds.has(check.id)),
    omittedChecks: Math.max(0, snapshot.checks.length - checks.length),
  };
}

function renderSnapshot(snapshot: ChecksDetails): string {
  const flags = [
    snapshot.timedOut ? "timed out" : undefined,
    snapshot.aborted ? "aborted" : undefined,
    snapshot.noChecksAllowed ? "no checks explicitly allowed" : undefined,
  ].filter(Boolean);
  const summary = `${snapshot.state}: ${snapshot.completed}/${snapshot.total} checks complete for ${snapshot.sha}`;
  const relevant = snapshot.failed.length > 0
    ? snapshot.failed
    : snapshot.cancelled.length > 0
      ? snapshot.cancelled
      : snapshot.pending;
  const lines = relevant.slice(0, 10).map((check) => `- ${check.name}: ${check.conclusion ?? check.status} (${check.url})`);
  if (snapshot.omittedChecks > 0) lines.push(`- ${snapshot.omittedChecks} more checks omitted`);
  return [summary + (flags.length ? ` (${flags.join(", ")})` : ""), ...lines].join("\n");
}

function requireParameters(params: Parameters): void {
  if (!params || !["status", "wait", "diagnose"].includes(params.action)) {
    throw new Error('action must be "status", "wait", or "diagnose".');
  }
  if (!/^[0-9a-f]{40}$/i.test(params.sha)) throw new Error("sha must be a full commit SHA.");
}
