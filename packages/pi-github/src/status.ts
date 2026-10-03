import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuthorityGrant } from "./authority.js";

export function statusLabel(
  grant: Pick<AuthorityGrant, "mode"> | null,
  progress?: { completed: number; total: number },
): string | null {
  if (!grant || grant.mode === "read-only") return null;
  if (grant.mode === "collaboration") return "GH ✎";
  return progress ? `GH 🚀 ${progress.completed}/${progress.total}` : "GH 🚀";
}

export function updateGitHubStatus(
  pi: ExtensionAPI,
  grant: Pick<AuthorityGrant, "mode"> | null,
  progress?: { completed: number; total: number },
): void {
  const label = statusLabel(grant, progress);
  if (!label) {
    pi.events.emit("pi-status:update", { id: "github", render: null });
    return;
  }
  pi.events.emit("pi-status:register", {
    id: "github",
    priority: 55,
    render: (theme: any) => theme.fg("accent", label),
  });
}
