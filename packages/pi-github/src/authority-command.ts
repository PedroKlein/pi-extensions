import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AuthorityGrant, AuthorityMode } from "./authority.js";

export interface AuthorityIdentity {
  sessionId: string;
  host: string;
  repository: string;
  login: string;
}

export interface AuthoritySelections {
  mode: AuthorityMode;
  mergeMethod?: "merge" | "squash" | "rebase";
  allowNoChecks?: boolean;
  blockOptionalFailures?: boolean;
  branchMode?: "create" | "adopt";
  deleteRemoteBranch?: boolean;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

export function grantFromSelections(
  identity: AuthorityIdentity,
  selections: AuthoritySelections,
): AuthorityGrant {
  if (selections.mode !== "autonomous") return { ...identity, mode: selections.mode };
  return {
    ...identity,
    mode: "autonomous",
    mergeMethod: selections.mergeMethod ?? "squash",
    allowNoChecks: selections.allowNoChecks ?? false,
    blockOptionalFailures: selections.blockOptionalFailures ?? true,
    branchMode: selections.branchMode ?? "create",
    deleteRemoteBranch: selections.deleteRemoteBranch ?? true,
  };
}

export function registerAuthorityCommand(
  pi: ExtensionAPI,
  options: {
    resolveIdentity: (ctx: ExtensionCommandContext) => Promise<AuthorityIdentity>;
    current: () => AuthorityGrant | null;
    grant: (grant: AuthorityGrant) => void;
    revoke: () => void;
    abortActive: () => void;
    updateStatus: (grant: AuthorityGrant | null) => void;
  },
): void {
  pi.registerCommand("github-autonomy", {
    description: "Grant, inspect, or revoke session-scoped GitHub authority",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(options.current() ? JSON.stringify(options.current(), null, 2) : "GitHub authority is not enabled.", "info");
        return;
      }
      if (action === "revoke") {
        options.abortActive();
        options.revoke();
        options.updateStatus(null);
        ctx.ui.notify("GitHub authority revoked for this session.", "info");
        return;
      }
      if (action) throw new Error("Usage: /github-autonomy [status|revoke]");
      if (!ctx.hasUI) throw new Error("GitHub authority requires interactive approval.");

      const identity = await options.resolveIdentity(ctx);
      const mode = await choose(ctx, "Question 1 — Authority mode (up to 5 follow-ups)", [
        { value: "read-only", label: "Read-only — inspect GitHub; no writes; finishes now" },
        { value: "collaboration", label: "Collaboration — confirmed writes to existing PRs/issues; finishes now" },
        { value: "autonomous", label: "Autonomous — owned branch, PR, issue, CI, and merge workflows; 5 questions remain" },
      ] as const);
      let selections: AuthoritySelections = { mode };
      if (mode === "autonomous") {
        selections = {
          mode,
          mergeMethod: await choose(ctx, "Question 2 of 6 — Merge method (4 remain)", [
            { value: "squash", label: "Squash (default) — one commit per PR" },
            { value: "rebase", label: "Rebase — replay every PR commit onto the base" },
            { value: "merge", label: "Merge commit — preserve branch topology" },
          ] as const),
          allowNoChecks: await yesNo(ctx, "Question 3 of 6 — Allow merge when no CI checks are discovered? (3 remain)", false,
            "Allows a locally verified PR to merge with zero GitHub checks.",
            "Blocks merge until at least one GitHub check completes successfully."),
          blockOptionalFailures: await yesNo(ctx, "Question 4 of 6 — Should failing optional checks block merge? (2 remain)", true,
            "Treats every failed check as blocking, including optional checks.",
            "Only required failed checks block merging."),
          branchMode: await choose(ctx, "Question 5 of 6 — Branch acquisition (1 remains)", [
            { value: "create", label: "Create (default) — publish HEAD to a new conventional branch" },
            { value: "adopt", label: "Adopt — use the current non-default branch only when it has no PR" },
          ] as const),
          deleteRemoteBranch: await yesNo(ctx, "Question 6 of 6 — Delete owned remote branch after merge? (final question)", true,
            "Deletes only the extension-owned remote branch; keeps the local branch.",
            "Retains both remote and local branches after merge."),
        };
      }
      const grant = grantFromSelections(identity, selections);
      options.grant(grant);
      options.updateStatus(grant);
      ctx.ui.notify(`GitHub ${mode} authority enabled for ${identity.repository} as ${identity.login}.`, "info");
    },
  });
}

async function choose<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  choices: readonly Choice<T>[],
): Promise<T> {
  const selected = await ctx.ui.select(title, choices.map((choice) => choice.label));
  const choice = choices.find((candidate) => candidate.label === selected);
  if (!choice) throw new Error("GitHub authority was not approved.");
  return choice.value;
}

async function yesNo(
  ctx: ExtensionCommandContext,
  title: string,
  defaultYes: boolean,
  yesDescription: string,
  noDescription: string,
): Promise<boolean> {
  return (await choose(ctx, title, defaultYes
    ? [
        { value: "yes", label: `Yes (default) — ${yesDescription}` },
        { value: "no", label: `No — ${noDescription}` },
      ]
    : [
        { value: "no", label: `No (default) — ${noDescription}` },
        { value: "yes", label: `Yes — ${yesDescription}` },
      ])) === "yes";
}
