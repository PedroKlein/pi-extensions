import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthorityGrant, OwnedResource } from "./authority.js";
import type { GitHubAdapter } from "./adapter.js";
import type { RepositoryIdentity } from "./repository.js";
import { requireFastForward, selectPublishBranch, type PublishState } from "./branch.js";
import { completeDelivery, type MergePort } from "./merge.js";

export interface ShipPort {
  state(signal?: AbortSignal): Promise<PublishState>;
  ancestors(sha: string, signal?: AbortSignal): Promise<Set<string>>;
  createBranch(branch: string, sha: string, signal?: AbortSignal): Promise<void>;
  push(branch: string, expectedRemoteSha: string | undefined, signal?: AbortSignal): Promise<{ remoteSha: string }>;
  findPullRequest(branch: string, signal?: AbortSignal): Promise<{ number: number; url: string; headSha: string } | null>;
  createPullRequest(input: { title: string; body: string; base: string; head: string }, signal?: AbortSignal): Promise<{ number: number; url: string; headSha: string }>;
}

export async function publishVerified(
  port: ShipPort,
  grant: AuthorityGrant,
  verificationSha: string,
  input: { branch?: string; title: string; body: string },
  signal?: AbortSignal,
): Promise<{ branch: string; number: number; url: string; headSha: string }> {
  if (grant.mode !== "autonomous") throw new Error("Autonomous GitHub authority is required.");
  const state = await port.state(signal);
  if (state.headSha !== verificationSha) throw new Error("Local verification is not bound to the current HEAD SHA.");
  const selected = selectPublishBranch(state, { branchMode: grant.branchMode ?? "create", requestedBranch: input.branch });
  if (selected.create) await port.createBranch(selected.branch, state.headSha, signal);
  requireFastForward(state.remoteSha, await port.ancestors(state.headSha, signal));
  const pushed = await port.push(selected.branch, state.remoteSha, signal);
  if (pushed.remoteSha !== state.headSha) throw new Error("Remote branch did not reach the verified HEAD SHA.");
  const existing = await port.findPullRequest(selected.branch, signal);
  const pullRequest = existing ?? await port.createPullRequest({ title: input.title, body: input.body, base: state.defaultBranch, head: selected.branch }, signal);
  if (pullRequest.headSha !== state.headSha) throw new Error("Pull request head does not match the verified SHA.");
  return { branch: selected.branch, ...pullRequest };
}

export class GitHubShipPort implements ShipPort {
  constructor(private readonly adapter: GitHubAdapter, private readonly repository: RepositoryIdentity) {}
  async state(signal?: AbortSignal): Promise<PublishState> {
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
    const [status, head, commits, prs] = await Promise.all([
      this.git(["status", "--porcelain"], signal),
      this.git(["rev-parse", "HEAD"], signal),
      this.git(["rev-list", "--count", `origin/${this.repository.defaultBranch}..HEAD`], signal),
      this.gh(["pr", "list", "--repo", `${this.repository.owner}/${this.repository.name}`, "--head", branch, "--state", "all", "--json", "number"], signal),
    ]);
    const remoteSha = await this.remoteSha(branch, signal);
    return { currentBranch: branch, defaultBranch: this.repository.defaultBranch, headSha: head, remoteSha, clean: status === "", hasLocalCommits: Number(commits) > 0, existingPullRequest: (JSON.parse(prs) as unknown[]).length > 0 };
  }
  async ancestors(sha: string, signal?: AbortSignal): Promise<Set<string>> { return new Set((await this.git(["rev-list", sha], signal)).trim().split("\n").filter(Boolean)); }
  async createBranch(branch: string, sha: string, signal?: AbortSignal): Promise<void> { await this.git(["branch", branch, sha], signal); }
  async push(branch: string, _expected: string | undefined, signal?: AbortSignal): Promise<{ remoteSha: string }> {
    const result = await this.adapter.runGit(["push", "origin", `HEAD:refs/heads/${branch}`], { mutation: true, signal });
    const remoteSha = await this.remoteSha(branch, signal);
    if (result.outcome === "failure" || !remoteSha) throw new Error(result.stderr || "Push failed.");
    if (result.outcome === "outcome-unknown" && !remoteSha) throw new Error("Push outcome is unknown.");
    return { remoteSha };
  }
  async findPullRequest(branch: string, signal?: AbortSignal) { const items = JSON.parse(await this.gh(["pr", "list", "--repo", `${this.repository.owner}/${this.repository.name}`, "--head", branch, "--state", "all", "--json", "number,url,headRefOid"], signal)) as Array<any>; return items[0] ? { number: items[0].number, url: items[0].url, headSha: items[0].headRefOid } : null; }
  async createPullRequest(input: { title: string; body: string; base: string; head: string }, signal?: AbortSignal) { const result = await this.adapter.runGh(this.repository.host, ["pr", "create", "--repo", `${this.repository.owner}/${this.repository.name}`, "--title", input.title, "--body", input.body, "--base", input.base, "--head", input.head], { mutation: true, signal }); if (result.outcome === "failure") throw new Error(result.stderr); const found = await this.findPullRequest(input.head, signal); if (!found) throw new Error("Pull request creation outcome is unknown."); return found; }
  private async remoteSha(branch: string, signal?: AbortSignal): Promise<string | undefined> { const result = await this.adapter.runGit(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { signal }); if (result.outcome !== "success") throw new Error(result.stderr); return result.stdout.trim().split(/\s+/, 1)[0] || undefined; }
  private async git(args: string[], signal?: AbortSignal): Promise<string> { const result = await this.adapter.runGit(args, { signal }); if (result.outcome !== "success") throw new Error(result.stderr || `git ${args[0]} failed.`); return result.stdout.trim(); }
  private async gh(args: string[], signal?: AbortSignal): Promise<string> { const result = await this.adapter.runGh(this.repository.host, args, { signal }); if (result.outcome !== "success") throw new Error(result.stderr || `gh ${args[0]} failed.`); return result.stdout; }
}

export function registerGitHubShip(
  pi: ExtensionAPI,
  exposure: "hidden" | "model-only",
  dependencies: {
    grant: () => AuthorityGrant | null;
    authorize?: () => Promise<void>;
    port: ShipPort;
    own: (resource: OwnedResource) => void;
    isOwned?: (resource: OwnedResource) => boolean;
    merge?: MergePort;
    release?: (resource: OwnedResource) => void;
  },
): void {
  pi.registerTool({
    name: "github_ship",
    label: "GitHub ship",
    description: "Publish an already committed and locally verified HEAD to an owned branch and ready pull request. This tool never stages or commits files.",
    promptGuidelines: ["Stage, commit, and verify locally before calling github_ship. The tool never chooses commit contents."],
    exposure,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    parameters: Type.Object({
      action: Type.Union([Type.Literal("publish"), Type.Literal("merge")]),
      verificationSha: Type.Optional(Type.String()),
      number: Type.Optional(Type.Integer({ minimum: 1 })),
      branch: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<unknown>> {
      const grant = dependencies.grant();
      if (!grant) throw new Error("GitHub authority is not enabled.");
      await dependencies.authorize?.();
      if (params.action === "merge") {
        if (!dependencies.merge || !params.number) throw new Error("Merge requires an owned pull request number.");
        if (!dependencies.isOwned?.({ kind: "pull-request", repository: grant.repository, number: params.number })) throw new Error("The pull request is not internally owned.");
        const receipt = await completeDelivery(dependencies.merge, grant, params.number, signal);
        if (receipt.state === "merged") {
          dependencies.release?.({ kind: "pull-request", repository: grant.repository, number: params.number });
          if ("branch" in receipt && receipt.branch) dependencies.release?.({ kind: "branch", repository: grant.repository, branch: receipt.branch });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }], details: receipt };
      }
      if (!params.verificationSha || !params.title || params.body === undefined) throw new Error("Publish requires verificationSha, title, and body.");
      const receipt = await publishVerified(dependencies.port, grant, params.verificationSha, params as { branch?: string; title: string; body: string }, signal);
      dependencies.own({ kind: "branch", repository: grant.repository, branch: receipt.branch, headSha: receipt.headSha });
      dependencies.own({ kind: "pull-request", repository: grant.repository, branch: receipt.branch, number: receipt.number, headSha: receipt.headSha });
      return { content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }], details: receipt };
    },
  });
}
