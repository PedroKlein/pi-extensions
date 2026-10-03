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
      const mode = await select(ctx, "GitHub authority mode", ["read-only", "collaboration", "autonomous"] as const);
      let selections: AuthoritySelections = { mode };
      if (mode === "autonomous") {
        selections = {
          mode,
          mergeMethod: await select(ctx, "Merge method", ["squash", "rebase", "merge"] as const),
          allowNoChecks: await yesNo(ctx, "Allow merge when no CI checks are discovered?", false),
          blockOptionalFailures: await yesNo(ctx, "Should failing optional checks block merge?", true),
          branchMode: await select(ctx, "Branch acquisition", ["create", "adopt"] as const),
          deleteRemoteBranch: await yesNo(ctx, "Delete the owned remote branch after merge?", true),
        };
      }
      const grant = grantFromSelections(identity, selections);
      options.grant(grant);
      options.updateStatus(grant);
      ctx.ui.notify(`GitHub ${mode} authority enabled for ${identity.repository} as ${identity.login}.`, "info");
    },
  });
}

async function select<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  values: readonly T[],
): Promise<T> {
  const selected = await ctx.ui.select(title, [...values]);
  if (!selected || !values.includes(selected as T)) throw new Error("GitHub authority was not approved.");
  return selected as T;
}

async function yesNo(ctx: ExtensionCommandContext, title: string, defaultYes: boolean): Promise<boolean> {
  const yes = defaultYes ? "Yes (default)" : "Yes";
  const no = defaultYes ? "No" : "No (default)";
  return (await select(ctx, title, [defaultYes ? yes : no, defaultYes ? no : yes] as const)).startsWith("Yes");
}
