import { encode } from "gpt-tokenizer/encoding/o200k_base";

export const REPO_CONTEXT_MARKER = "pi-repos-injected-marker";
export const STARTUP_CONTEXT_MARKER = "pi-repos-startup-marker";

export function injectedRepoIdsFromBranch(branch: unknown[]): Set<string> {
  const repoIds = new Set<string>();
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      record.type !== "custom" ||
      record.customType !== REPO_CONTEXT_MARKER ||
      !record.data ||
      typeof record.data !== "object"
    ) {
      continue;
    }
    const repoId = (record.data as Record<string, unknown>).repoId;
    if (typeof repoId === "string") repoIds.add(repoId);
  }
  return repoIds;
}

export function hasStartupContextMarker(
  branch: unknown[],
  repoId: string,
): boolean {
  return branch.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    if (
      record.type !== "custom" ||
      record.customType !== STARTUP_CONTEXT_MARKER ||
      !record.data ||
      typeof record.data !== "object"
    ) {
      return false;
    }
    return (record.data as Record<string, unknown>).repoId === repoId;
  });
}

export interface RepoSummaryContext {
  content: string;
  truncated: boolean;
  tokens: number;
}

export function buildRepoSummaryContext(
  repoId: string,
  tldr: string,
  tokenBudget = 500,
): RepoSummaryContext {
  const prefix = `**pi-repos:** You are reading from \`${repoId}\`. Stored summary:\n\n`;
  const full = `${prefix}${tldr.trim()}`;
  const fullTokens = encode(full).length;
  if (fullTokens <= tokenBudget) {
    return { content: full, truncated: false, tokens: fullTokens };
  }

  const suffix =
    `\n\n[Summary truncated to ${tokenBudget} tokens. ` +
    `Use repos_info for the full summary and annotations.]`;
  let low = 0;
  let high = tldr.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${prefix}${tldr.slice(0, middle).trimEnd()}${suffix}`;
    if (encode(candidate).length <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    content: best || `${prefix}${suffix.trimStart()}`,
    truncated: true,
    tokens: encode(best || `${prefix}${suffix.trimStart()}`).length,
  };
}
