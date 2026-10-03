export const AUTHORITY_ENTRY_TYPE = "pi-github-authority";

export type AuthorityMode = "read-only" | "collaboration" | "autonomous";

export interface AuthorityGrant {
  mode: AuthorityMode;
  sessionId: string;
  host: string;
  repository: string;
  login: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  allowNoChecks?: boolean;
  blockOptionalFailures?: boolean;
  branchMode?: "create" | "adopt";
  deleteRemoteBranch?: boolean;
}

export interface OwnedResource {
  kind: "branch" | "pull-request" | "issue";
  repository: string;
  branch?: string;
  number?: number;
  headSha?: string;
}

export type AuthorityTransition =
  | { version: 1; kind: "grant"; at: number; grant: AuthorityGrant }
  | { version: 1; kind: "revoke"; at: number; sessionId: string }
  | { version: 1; kind: "own"; at: number; sessionId: string; resource: OwnedResource }
  | { version: 1; kind: "release"; at: number; sessionId: string; resource: OwnedResource };

export interface AuthorityState {
  grant: AuthorityGrant | null;
  ownership: OwnedResource[];
}

export function replayAuthority(entries: readonly unknown[], sessionId: string): AuthorityState {
  let grant: AuthorityGrant | null = null;
  const ownership: OwnedResource[] = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (entry?.type !== "custom" || entry.customType !== AUTHORITY_ENTRY_TYPE) continue;
    const transition = parseTransition(entry.data);
    if (!transition) continue;
    if (transition.kind === "grant" && transition.grant.sessionId === sessionId) grant = transition.grant;
    if (transition.kind === "revoke" && transition.sessionId === sessionId) grant = null;
    if (transition.kind === "own" && transition.sessionId === sessionId) ownership.push(transition.resource);
    if (transition.kind === "release" && transition.sessionId === sessionId) {
      const index = ownership.findIndex((owned) => sameResource(owned, transition.resource));
      if (index >= 0) ownership.splice(index, 1);
    }
  }
  return { grant, ownership };
}

export function createAuthorityStore(
  sessionId: string,
  append: (transition: AuthorityTransition) => void,
  initial: AuthorityState = { grant: null, ownership: [] },
) {
  let state: AuthorityState = { grant: initial.grant, ownership: [...initial.ownership] };
  const apply = (transition: AuthorityTransition) => {
    append(transition);
    state = replayAuthority([
      ...(state.grant ? [{ type: "custom", customType: AUTHORITY_ENTRY_TYPE, data: { version: 1, kind: "grant", at: 0, grant: state.grant } }] : []),
      ...state.ownership.map((resource) => ({ type: "custom", customType: AUTHORITY_ENTRY_TYPE, data: { version: 1, kind: "own", at: 0, sessionId, resource } })),
      { type: "custom", customType: AUTHORITY_ENTRY_TYPE, data: transition },
    ], sessionId);
  };
  return {
    grant(grant: AuthorityGrant) { apply({ version: 1, kind: "grant", at: Date.now(), grant }); },
    revoke() { apply({ version: 1, kind: "revoke", at: Date.now(), sessionId }); },
    own(resource: OwnedResource) { apply({ version: 1, kind: "own", at: Date.now(), sessionId, resource }); },
    release(resource: OwnedResource) { apply({ version: 1, kind: "release", at: Date.now(), sessionId, resource }); },
    current: () => ({ grant: state.grant, ownership: [...state.ownership] }),
  };
}

function parseTransition(value: unknown): AuthorityTransition | null {
  const transition = record(value);
  if (!transition || transition.version !== 1 || typeof transition.kind !== "string") return null;
  if (transition.kind === "grant") {
    const grant = record(transition.grant);
    if (!grant || !["read-only", "collaboration", "autonomous"].includes(String(grant.mode))) return null;
    if (![grant.sessionId, grant.host, grant.repository, grant.login].every(nonEmpty)) return null;
    return transition as unknown as AuthorityTransition;
  }
  if (!["revoke", "own", "release"].includes(transition.kind) || !nonEmpty(transition.sessionId)) return null;
  return transition as unknown as AuthorityTransition;
}

function sameResource(left: OwnedResource, right: OwnedResource): boolean {
  return left.kind === right.kind && left.repository === right.repository
    && left.branch === right.branch && left.number === right.number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
