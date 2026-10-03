import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitHubAdapter } from "./adapter.js";
import { AUTHORITY_ENTRY_TYPE, createAuthorityStore, replayAuthority, type AuthorityGrant } from "./authority.js";
import { registerAuthorityCommand } from "./authority-command.js";
import { GitHubCheckSource, type CheckSource } from "./checks.js";
import { registerGitHubChecks } from "./checks-tool.js";
import { GitHubCollaborationSource, registerCollaborationTools, type CollaborationSource } from "./collaboration-tools.js";
import { discoverRepository, type RepositoryIdentity } from "./repository.js";
import { authorizeMutation, blockedGitHubMutation } from "./policy.js";
import { updateGitHubStatus } from "./status.js";
import { GitHubMergePort, type MergePort } from "./merge.js";
import { GitHubShipPort, registerGitHubShip, type ShipPort } from "./ship.js";

export default function githubExtension(pi: ExtensionAPI): void {
  const adapter = new GitHubAdapter();
  let sessionId = "";
  let authority = createAuthorityStore(sessionId, (transition) => pi.appendEntry(AUTHORITY_ENTRY_TYPE, transition));
  let activeAbort = new AbortController();
  const operationSignal = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, activeAbort.signal])
    : activeAbort.signal;
  let repository: Promise<RepositoryIdentity> | undefined;
  const getRepository = (signal?: AbortSignal) => repository ??= discoverRepository(async (command, args) => {
    const result = await adapter.run(command, args, { signal });
    return result;
  });
  let source: Promise<CheckSource> | undefined;
  registerGitHubChecks(pi, {
    async observe(sha, signal) {
      const activeSignal = operationSignal(signal);
      source ??= getRepository(activeSignal).then((resolved) => new GitHubCheckSource(
        adapter,
        resolved.host,
        `${resolved.owner}/${resolved.name}`,
      ));
      return (await source).observe(sha, activeSignal);
    },
    async diagnose(sha, signal) {
      const activeSignal = operationSignal(signal);
      source ??= getRepository(activeSignal).then((resolved) => new GitHubCheckSource(
        adapter,
        resolved.host,
        `${resolved.owner}/${resolved.name}`,
      ));
      const checkSource = await source;
      if (!checkSource.diagnose) throw new Error("Failure diagnosis is unavailable.");
      return checkSource.diagnose(sha, activeSignal);
    },
  }, {
    onProgress: (snapshot) => updateGitHubStatus(
      pi,
      authority.current().grant,
      snapshot ? { completed: snapshot.completed, total: snapshot.total } : undefined,
    ),
  });

  let collaboration: Promise<CollaborationSource> | undefined;
  const collaborationSource: CollaborationSource = {
    listPullRequests: async (signal) => (await getCollaboration(operationSignal(signal))).listPullRequests(operationSignal(signal)),
    getPullRequest: async (number, signal) => (await getCollaboration(operationSignal(signal))).getPullRequest(number, operationSignal(signal)),
    listIssues: async (signal) => (await getCollaboration(operationSignal(signal))).listIssues(operationSignal(signal)),
    getIssue: async (number, signal) => (await getCollaboration(operationSignal(signal))).getIssue(number, operationSignal(signal)),
    mutatePullRequest: async (params, signal) => (await getCollaboration(operationSignal(signal))).mutatePullRequest!(params, operationSignal(signal)),
    mutateIssue: async (params, signal) => (await getCollaboration(operationSignal(signal))).mutateIssue!(params, operationSignal(signal)),
  };
  const getCollaboration = (signal?: AbortSignal) => collaboration ??= getRepository(signal)
    .then((resolved) => new GitHubCollaborationSource(
      adapter,
      resolved.host,
      `${resolved.owner}/${resolved.name}`,
    ));
  let ship: Promise<ShipPort> | undefined;
  const getShip = (signal?: AbortSignal) => ship ??= getRepository(signal).then((resolved) => new GitHubShipPort(adapter, resolved));
  let merge: Promise<MergePort> | undefined;
  const getMerge = (signal?: AbortSignal) => merge ??= Promise.all([getRepository(signal), source ??= getRepository(signal).then((resolved) => new GitHubCheckSource(adapter, resolved.host, `${resolved.owner}/${resolved.name}`))])
    .then(([resolved, checks]) => new GitHubMergePort(adapter, checks, resolved.host, `${resolved.owner}/${resolved.name}`));
  const mergePort: MergePort = {
    head: async (number, signal) => (await getMerge(operationSignal(signal))).head(number, operationSignal(signal)),
    wait: async (sha, allowNoChecks, blockOptionalFailures, signal) => (await getMerge(operationSignal(signal))).wait(sha, allowNoChecks, blockOptionalFailures, operationSignal(signal)),
    merge: async (number, sha, method, signal) => (await getMerge(operationSignal(signal))).merge(number, sha, method, operationSignal(signal)),
    enableAutoMerge: async (number, sha, method, signal) => (await getMerge(operationSignal(signal))).enableAutoMerge(number, sha, method, operationSignal(signal)),
    deleteRemoteBranch: async (branch, signal) => (await getMerge(operationSignal(signal))).deleteRemoteBranch(branch, operationSignal(signal)),
  };
  const shipPort: ShipPort = {
    state: async (signal) => (await getShip(operationSignal(signal))).state(operationSignal(signal)),
    ancestors: async (sha, signal) => (await getShip(operationSignal(signal))).ancestors(sha, operationSignal(signal)),
    createBranch: async (branch, sha, signal) => (await getShip(operationSignal(signal))).createBranch(branch, sha, operationSignal(signal)),
    push: async (branch, expected, signal) => (await getShip(operationSignal(signal))).push(branch, expected, operationSignal(signal)),
    findPullRequest: async (branch, signal) => (await getShip(operationSignal(signal))).findPullRequest(branch, operationSignal(signal)),
    createPullRequest: async (input, signal) => (await getShip(operationSignal(signal))).createPullRequest(input, operationSignal(signal)),
  };
  const authorizeCurrent = async (
    resourceKind?: "pull-request" | "issue",
    resourceNumber?: number,
  ) => {
    if (resourceKind && resourceNumber !== undefined && (!Number.isInteger(resourceNumber) || resourceNumber <= 0)) {
      throw new Error(`Invalid ${resourceKind} number.`);
    }
    const grant = authority.current().grant;
    const resolved = await getRepository();
    const identity = await adapter.resolveIdentity(resolved.host);
    authorizeMutation({
      grant,
      sessionId,
      host: resolved.host,
      repository: `${resolved.owner}/${resolved.name}`,
      requiresOwnership: false,
      owned: true,
    });
    if (grant?.login !== identity.login) throw new Error("GitHub authority belongs to another authenticated login.");
  };
  registerCollaborationTools(pi, collaborationSource, {
    authorize: async (kind, number) => authorizeCurrent(kind, number),
    canCreate: () => authority.current().grant?.mode === "autonomous",
    isOwned: (kind, number) => authority.current().ownership.some((resource) => resource.kind === kind && resource.number === number),
    own: (resource) => authority.own(resource),
  });

  const shipDependencies = {
    grant: () => authority.current().grant,
    authorize: () => authorizeCurrent(),
    port: shipPort,
    own: (resource: import("./authority.js").OwnedResource) => authority.own(resource),
    isOwned: (resource: import("./authority.js").OwnedResource) => authority.current().ownership.some((owned) =>
      owned.kind === resource.kind && owned.repository === resource.repository
      && (resource.number === undefined || owned.number === resource.number)
      && (resource.branch === undefined || owned.branch === resource.branch)),
    merge: mergePort,
    release: (resource: import("./authority.js").OwnedResource) => authority.release(resource),
  };
  const setShipExposure = (grant: AuthorityGrant | null) => {
    const enabled = grant?.mode === "autonomous";
    registerGitHubShip(pi, enabled ? "model-only" : "hidden", shipDependencies);
    pi.setActiveTools([
      ...pi.getActiveTools().filter((name) => name !== "github_ship"),
      ...(enabled ? ["github_ship"] : []),
    ]);
  };
  registerGitHubShip(pi, "hidden", shipDependencies);

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    authority = createAuthorityStore(
      sessionId,
      (transition) => pi.appendEntry(AUTHORITY_ENTRY_TYPE, transition),
      replayAuthority(ctx.sessionManager.getBranch(), sessionId),
    );
    updateGitHubStatus(pi, authority.current().grant);
    setShipExposure(authority.current().grant);
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") return;
    const reason = blockedGitHubMutation(input.command);
    return reason ? { block: true, reason } : undefined;
  });
  registerAuthorityCommand(pi, {
    resolveIdentity: async (ctx) => {
      const resolved = await getRepository();
      const identity = await adapter.resolveIdentity(resolved.host);
      return {
        sessionId: ctx.sessionManager.getSessionId(),
        host: resolved.host,
        repository: `${resolved.owner}/${resolved.name}`,
        login: identity.login,
      };
    },
    current: () => authority.current().grant,
    grant: (grant: AuthorityGrant) => authority.grant(grant),
    revoke: () => authority.revoke(),
    abortActive: () => {
      activeAbort.abort();
      activeAbort = new AbortController();
    },
    updateStatus: (grant) => {
      updateGitHubStatus(pi, grant);
      setShipExposure(grant);
    },
  });
}
