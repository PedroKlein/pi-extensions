export interface PublishState {
  currentBranch: string;
  defaultBranch: string;
  headSha: string;
  remoteSha?: string;
  clean: boolean;
  hasLocalCommits: boolean;
  existingPullRequest: boolean;
}

export function selectPublishBranch(
  state: PublishState,
  options: { branchMode: "create" | "adopt"; requestedBranch?: string },
): { branch: string; create: boolean } {
  if (!state.clean) throw new Error("Publishing requires a clean worktree.");
  if (!state.hasLocalCommits) throw new Error("There are no local commits to publish.");
  if (!/^[0-9a-f]{40}$/i.test(state.headSha)) throw new Error("Publishing requires a full local HEAD SHA.");
  if (state.currentBranch === state.defaultBranch) {
    if (!options.requestedBranch?.trim()) throw new Error("A new branch name is required when publishing from the default branch.");
    if (options.requestedBranch === state.defaultBranch) throw new Error("Publishing the default branch is prohibited.");
    return { branch: options.requestedBranch, create: true };
  }
  if (options.branchMode !== "adopt") throw new Error("The current branch is not internally owned.");
  if (state.existingPullRequest) throw new Error("A branch with an existing pull request cannot be adopted.");
  return { branch: state.currentBranch, create: false };
}

export function requireFastForward(remoteSha: string | undefined, ancestors: Set<string>): void {
  if (remoteSha && !ancestors.has(remoteSha)) throw new Error("Publishing would require a non-fast-forward update.");
}
