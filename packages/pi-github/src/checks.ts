import { formatDiagnosis, type FailureDiagnosis } from "./diagnosis.js";
import type { GitHubAdapter } from "./adapter.js";

export type ChecksState = "no-checks" | "pending" | "passed" | "failed" | "cancelled";

export interface CheckItem {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  required?: boolean;
}

export interface CheckObservation {
  sha: string;
  checks: CheckItem[];
}

export interface ChecksSnapshot extends CheckObservation {
  state: ChecksState;
  total: number;
  completed: number;
  pending: CheckItem[];
  failed: CheckItem[];
  cancelled: CheckItem[];
  timedOut?: boolean;
  aborted?: boolean;
  noChecksAllowed?: boolean;
}

export interface CheckSource {
  observe(sha: string, signal?: AbortSignal): Promise<CheckObservation>;
  diagnose?(sha: string, signal?: AbortSignal): Promise<FailureDiagnosis>;
}

interface WaitOptions {
  sha: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  allowNoChecks?: boolean;
  blockOptionalFailures?: boolean;
  signal?: AbortSignal;
  onUpdate?: (snapshot: ChecksSnapshot) => void;
}

const TERMINAL_FAILURES = new Set([
  "action_required",
  "failure",
  "startup_failure",
  "stale",
  "timed_out",
]);
const CANCELLATIONS = new Set(["cancelled"]);
const COMPLETED_STATUSES = new Set(["completed"]);

export function aggregateChecks(
  observation: CheckObservation,
  options: { blockOptionalFailures?: boolean } = {},
): ChecksSnapshot {
  requireSha(observation.sha);
  if (observation.checks.length === 0) {
    return {
      ...observation,
      state: "no-checks",
      total: 0,
      completed: 0,
      pending: [],
      failed: [],
      cancelled: [],
    };
  }

  const pending = observation.checks.filter((check) => !COMPLETED_STATUSES.has(check.status));
  const failed = observation.checks.filter((check) =>
    TERMINAL_FAILURES.has(check.conclusion ?? "")
    && (options.blockOptionalFailures !== false || check.required !== false),
  );
  const cancelled = observation.checks.filter((check) => CANCELLATIONS.has(check.conclusion ?? ""));
  const completed = observation.checks.length - pending.length;
  const state: ChecksState = pending.length > 0
    ? "pending"
    : failed.length > 0
      ? "failed"
      : cancelled.length > 0
        ? "cancelled"
        : "passed";
  return {
    ...observation,
    state,
    total: observation.checks.length,
    completed,
    pending,
    failed,
    cancelled,
  };
}

export async function waitForChecks(
  observe: (signal?: AbortSignal) => Promise<CheckObservation>,
  options: WaitOptions,
): Promise<ChecksSnapshot> {
  requireSha(options.sha);
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const heartbeatMs = options.heartbeatMs ?? 60_000;
  const startedAt = Date.now();
  let nextDelay = pollIntervalMs;
  let lastUpdateKey: string | undefined;
  let lastUpdateAt = 0;
  let latest = aggregateChecks({ sha: options.sha, checks: [] });

  while (true) {
    if (options.signal?.aborted) return { ...latest, aborted: true };
    try {
      const observed = await observe(options.signal);
      if (observed.sha !== options.sha) {
        throw new Error(`Checks observation SHA ${observed.sha} did not match requested SHA ${options.sha}.`);
      }
      latest = aggregateChecks(observed, { blockOptionalFailures: options.blockOptionalFailures });
      nextDelay = pollIntervalMs;
    } catch (error) {
      if (options.signal?.aborted) return { ...latest, aborted: true };
      if (!isRateLimitError(error)) throw error;
      nextDelay = Math.min(nextDelay * 2, 60_000);
    }

    const now = Date.now();
    const updateKey = snapshotKey(latest);
    if (updateKey !== lastUpdateKey || now - lastUpdateAt >= heartbeatMs) {
      options.onUpdate?.(latest);
      lastUpdateKey = updateKey;
      lastUpdateAt = now;
    }

    if (latest.state === "passed" || latest.state === "failed" || latest.state === "cancelled") {
      return latest;
    }
    if (latest.state === "no-checks" && options.allowNoChecks) {
      return { ...latest, state: "passed", noChecksAllowed: true };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) return { ...latest, timedOut: true };
    const delay = Math.min(nextDelay, options.timeoutMs - elapsed);
    if (!(await sleep(delay, options.signal))) return { ...latest, aborted: true };
  }
}

export class GitHubCheckSource implements CheckSource {
  constructor(
    private readonly adapter: GitHubAdapter,
    private readonly host: string,
    private readonly repository: string,
  ) {}

  async diagnose(sha: string, signal?: AbortSignal): Promise<FailureDiagnosis> {
    requireSha(sha);
    const runs = await this.json([
      "api", "--hostname", this.host,
      `repos/${this.repository}/actions/runs?head_sha=${sha}&per_page=20`,
    ], signal) as { workflow_runs?: Array<Record<string, unknown>> };
    const run = (runs.workflow_runs ?? []).find((item) =>
      ["failure", "startup_failure", "cancelled", "timed_out", "action_required"].includes(String(item.conclusion)),
    );
    if (!run) throw new Error(`No failed workflow run found for ${sha}.`);
    const runId = number(run.id, "workflow run id");
    const attempt = typeof run.run_attempt === "number" ? run.run_attempt : 1;
    const jobsPayload = await this.json([
      "api", "--hostname", this.host,
      `repos/${this.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ], signal) as { jobs?: Array<Record<string, unknown>> };
    const jobs = (jobsPayload.jobs ?? [])
      .filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped")
      .map((job) => ({
        name: text(job.name, "job name"),
        conclusion: text(job.conclusion, "job conclusion"),
        steps: Array.isArray(job.steps) ? job.steps
          .filter((step) => step && typeof step === "object" && (step as Record<string, unknown>).conclusion !== "success")
          .map((step) => {
            const item = step as Record<string, unknown>;
            return { name: text(item.name, "step name"), conclusion: text(item.conclusion, "step conclusion") };
          }) : [],
      }));
    const logs = await this.adapter.runGh(this.host, [
      "run", "view", String(runId), "--repo", this.repository, "--attempt", String(attempt), "--log-failed",
    ], { signal });
    return formatDiagnosis({
      runId,
      attempt,
      sha,
      conclusion: text(run.conclusion, "workflow conclusion"),
      url: text(run.html_url, "workflow URL"),
      jobs,
      annotations: [],
      logs: logs.outcome === "success" ? logs.stdout : null,
    }, {
      persistDirectory: process.env.TMPDIR,
      secrets: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN],
    });
  }

  private async json(args: string[], signal?: AbortSignal): Promise<unknown> {
    const result = await this.adapter.runGh(this.host, args, { signal });
    if (result.outcome !== "success") throw commandError(result.stderr, "GitHub data");
    return JSON.parse(result.stdout);
  }

  async observe(sha: string, signal?: AbortSignal): Promise<CheckObservation> {
    requireSha(sha);
    const [runs, statuses] = await Promise.all([
      this.adapter.runGh(this.host, [
        "api",
        "--hostname",
        this.host,
        `repos/${this.repository}/commits/${sha}/check-runs`,
      ], { signal }),
      this.adapter.runGh(this.host, [
        "api",
        "--hostname",
        this.host,
        `repos/${this.repository}/commits/${sha}/status`,
      ], { signal }),
    ]);
    if (runs.outcome !== "success") throw commandError(runs.stderr, "check runs");
    if (statuses.outcome !== "success") throw commandError(statuses.stderr, "commit statuses");
    return {
      sha,
      checks: [
        ...parseCheckRuns(runs.stdout),
        ...parseStatuses(statuses.stdout),
      ],
    };
  }
}

function parseCheckRuns(value: string): CheckItem[] {
  const parsed = JSON.parse(value) as { check_runs?: Array<Record<string, unknown>> };
  return (parsed.check_runs ?? []).map((check) => ({
    id: number(check.id, "check run id"),
    name: text(check.name, "check run name"),
    status: text(check.status, "check run status"),
    conclusion: check.conclusion === null ? null : text(check.conclusion, "check run conclusion"),
    url: text(check.html_url ?? check.details_url, "check run URL"),
    required: typeof check.required === "boolean" ? check.required : undefined,
  }));
}

function parseStatuses(value: string): CheckItem[] {
  const parsed = JSON.parse(value) as { statuses?: Array<Record<string, unknown>> };
  return (parsed.statuses ?? []).map((status, index) => ({
    id: typeof status.id === "number" ? status.id : -(index + 1),
    name: text(status.context, "status context"),
    status: status.state === "pending" ? "in_progress" : "completed",
    conclusion: status.state === "pending" ? null : status.state === "success" ? "success" : "failure",
    url: typeof status.target_url === "string" && status.target_url ? status.target_url : "https://github.com",
    required: typeof status.required === "boolean" ? status.required : undefined,
  }));
}

function requireSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("A full commit SHA is required.");
}

function snapshotKey(snapshot: ChecksSnapshot): string {
  return JSON.stringify(snapshot.checks.map((check) => [check.id, check.status, check.conclusion]));
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && /rate.?limit|secondary limit|HTTP 429/i.test(error.message);
}

function commandError(message: string, subject: string): Error {
  return new Error(message || `Failed to fetch ${subject}.`);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const abort = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(completed);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing.`);
  return value;
}

function number(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} is missing.`);
  return value as number;
}
