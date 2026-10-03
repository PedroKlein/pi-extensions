import type { AuthorityGrant } from "./authority.js";
import type { GitHubAdapter } from "./adapter.js";
import { waitForChecks, type CheckSource, type ChecksSnapshot } from "./checks.js";

export interface MergePort {
  head(number: number, signal?: AbortSignal): Promise<{ sha: string; branch: string; reviewDecision?: string; mergeState?: string }>;
  wait(sha: string, allowNoChecks: boolean, blockOptionalFailures: boolean, signal?: AbortSignal): Promise<ChecksSnapshot>;
  merge(number: number, sha: string, method: string, signal?: AbortSignal): Promise<"merged" | "blocked" | "unknown">;
  enableAutoMerge(number: number, sha: string, method: string, signal?: AbortSignal): Promise<boolean>;
  deleteRemoteBranch(branch: string, signal?: AbortSignal): Promise<boolean>;
}

export class GitHubMergePort implements MergePort {
  constructor(private readonly adapter: GitHubAdapter, private readonly checks: CheckSource, private readonly host: string, private readonly repository: string) {}
  async head(number: number, signal?: AbortSignal) {
    const value = await this.json([
      "pr", "view", String(number), "--repo", this.repository,
      "--json", "headRefOid,headRefName,state",
    ], signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("GitHub returned invalid pull request head data.");
    }
    const data = value as Record<string, unknown>;
    if (typeof data.headRefOid !== "string" || typeof data.headRefName !== "string") {
      throw new Error("GitHub pull request head identity is incomplete.");
    }
    return {
      sha: data.headRefOid,
      branch: data.headRefName,
      mergeState: typeof data.state === "string" ? data.state : undefined,
    };
  }
  wait(sha: string, allowNoChecks: boolean, blockOptionalFailures: boolean, signal?: AbortSignal) { return waitForChecks((active) => this.checks.observe(sha, active), { sha, allowNoChecks, blockOptionalFailures, signal, timeoutMs: 30 * 60_000 }); }
  async merge(number: number, sha: string, method: string, signal?: AbortSignal): Promise<"merged" | "blocked" | "unknown"> { const result = await this.adapter.runGh(this.host, ["pr", "merge", String(number), "--repo", this.repository, `--${method}`, "--match-head-commit", sha], { mutation: true, signal }); if (result.outcome === "success") return "merged"; if (result.outcome === "outcome-unknown") return "unknown"; return /review|required|queue|not mergeable/i.test(result.stderr) ? "blocked" : Promise.reject(new Error(result.stderr)); }
  async enableAutoMerge(number: number, sha: string, method: string, signal?: AbortSignal): Promise<boolean> { const result = await this.adapter.runGh(this.host, ["pr", "merge", String(number), "--repo", this.repository, "--auto", `--${method}`, "--match-head-commit", sha], { mutation: true, signal }); return result.outcome === "success"; }
  async deleteRemoteBranch(branch: string, signal?: AbortSignal): Promise<boolean> { const result = await this.adapter.runGit(["push", "origin", "--delete", branch], { mutation: true, signal }); return result.outcome === "success"; }
  private async json(args: string[], signal?: AbortSignal): Promise<unknown> { const result = await this.adapter.runGh(this.host, args, { signal }); if (result.outcome !== "success") throw new Error(result.stderr); return JSON.parse(result.stdout); }
}

export async function completeDelivery(
  port: MergePort,
  grant: AuthorityGrant,
  number: number,
  signal?: AbortSignal,
) {
  if (grant.mode !== "autonomous") throw new Error("Autonomous GitHub authority is required.");
  for (let changes = 0; changes < 5; changes++) {
    const before = await port.head(number, signal);
    const checks = await port.wait(before.sha, grant.allowNoChecks ?? false, grant.blockOptionalFailures ?? true, signal);
    if (checks.state !== "passed") return { state: "checks-failed", number, headSha: before.sha, checks };
    const after = await port.head(number, signal);
    if (after.sha !== before.sha) continue;
    const method = grant.mergeMethod ?? "squash";
    const merge = await port.merge(number, before.sha, method, signal);
    if (merge === "merged") {
      const branchDeleted = grant.deleteRemoteBranch ? await port.deleteRemoteBranch(after.branch, signal) : false;
      return { state: "merged", number, headSha: before.sha, branch: after.branch, method, branchDeleted };
    }
    if (merge === "blocked") {
      const queued = await port.enableAutoMerge(number, before.sha, method, signal);
      return { state: queued ? "auto-merge-enabled" : "awaiting-review", number, headSha: before.sha, method };
    }
    const reconciled = await port.head(number, signal);
    if (reconciled.mergeState === "MERGED") return { state: "merged", number, headSha: before.sha, branch: reconciled.branch, method, branchDeleted: false };
    return { state: "outcome-unknown", number, headSha: before.sha, method };
  }
  return { state: "head-keeps-changing", number };
}
