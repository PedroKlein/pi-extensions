import type { AuthorityGrant } from "./authority.js";

export function blockedGitHubMutation(command: string): string | null {
  const normalized = command.trim();
  const blocked = [
    /(?:^|[;&|]\s*)git\s+push\b/i,
    /(?:^|[;&|]\s*)gh\s+pr\s+(?:create|edit|comment|review|merge|close|reopen|ready)\b/i,
    /(?:^|[;&|]\s*)gh\s+issue\s+(?:create|edit|comment|close|reopen|delete|transfer|pin|unpin)\b/i,
    /(?:^|[;&|]\s*)gh\s+api\b[^\n]*(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b/i,
  ];
  return blocked.some((pattern) => pattern.test(normalized))
    ? "Direct GitHub mutation is blocked. Use the typed GitHub tools so authority and ownership checks apply."
    : null;
}

export function authorizeMutation(input: {
  grant: AuthorityGrant | null;
  sessionId: string;
  host: string;
  repository: string;
  branch?: string;
  defaultBranch?: string;
  force?: boolean;
  requiresOwnership?: boolean;
  owned?: boolean;
}): void {
  if (!input.grant || input.grant.mode === "read-only") throw new Error("GitHub mutation authority is not enabled.");
  if (input.grant.sessionId !== input.sessionId) throw new Error("GitHub authority belongs to another session.");
  if (input.grant.host !== input.host) throw new Error("GitHub authority belongs to another host.");
  if (input.grant.repository !== input.repository) throw new Error("GitHub authority belongs to another repository.");
  if (input.force) throw new Error("Force and history-rewriting updates are prohibited.");
  if (input.branch && input.defaultBranch && input.branch === input.defaultBranch) {
    throw new Error("Pushing the default branch is prohibited.");
  }
  if (input.requiresOwnership && !input.owned) throw new Error("The GitHub resource is not internally owned.");
}

export async function confirmExistingMutation(
  hasUI: boolean,
  confirm: (title: string, message: string) => Promise<boolean>,
  title: string,
  exactContent: string,
): Promise<void> {
  if (!hasUI) throw new Error("Mutating an existing GitHub resource requires interactive confirmation.");
  if (!(await confirm(title, exactContent))) throw new Error("GitHub mutation was not approved.");
}
