/**
 * pi-repos — Repo management + orchestration layer for pi.
 *
 * Manages cloned and registered repos with summarization and hooks.
 * Provides 8 tools for repo lifecycle, search, annotations, groups, and sync.
 *
 * Tools:
 * - repos_add:      Clone URL or register local path
 * - repos_info:     Full details, TL;DR, annotations, freshness
 * - repos_list:     All repos with freshness indicators
 * - repos_remove:   Remove entry (cloned: delete storage; local: index only)
 * - repos_search:   Ripgrep across repos
 * - repos_annotate: Append knowledge notes (architecture/pattern/bug/decision/cross-cutting)
 * - repos_group:    Group CRUD + connections + docs + sync
 * - repos_sync:     Fetch updates + re-index if stale
 *
 * Lifecycle:
 * - session_start:  Load config, detect cwd repo → inject connections/references into LLM context
 * - tool_result:    Detect reads in managed paths → auto-inject TL;DR (once per repo per session)
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getPaths, expandTilde } from "./config.js";
import {
  buildRepoSummaryContext,
  hasStartupContextMarker,
  injectedRepoIdsFromBranch,
  REPO_CONTEXT_MARKER,
  STARTUP_CONTEXT_MARKER,
} from "./context.js";
import { ensureStorageDirs, loadIndex, saveIndex, resolveRepo, repoId, repoMetaDir, groupDir, appendAnnotation, readSummary, addReference, removeReference } from "./storage.js";
import { cloneRepo, registerLocal, removeRepo, syncRepo, listRepos } from "./clone.js";
import { searchRepos } from "./search.js";
import { createGroup, addToGroup, removeFromGroup, getGroupInfo, connectRepos, manageDocs, syncGroup, addGroupReference, removeGroupReference, listGroups } from "./group.js";
import { getRepoInfo, generateGroupDocs } from "./summarize.js";
import { suggestConnections } from "./suggest.js";
import type {
  ReposConfig,
  AddOutput,
  RemoveOutput,
  ListOutput,
  SyncOutput,
  AnnotateOutput,
  GroupOutput,
  Reference,
} from "./types.js";

type ToolResult = AgentToolResult<unknown>;

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}



export default function piRepos(pi: ExtensionAPI): void {
  let config: ReposConfig = loadConfig();
  // Active-branch scoped: repos that already had TL;DR injected.
  const injectedRepos = new Set<string>();
  let cwdRepoId: string | null = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig();
      ensureStorageDirs(config);
      injectedRepos.clear();
      for (const id of injectedRepoIdsFromBranch(ctx.sessionManager.getBranch())) {
        injectedRepos.add(id);
      }
      cwdRepoId = null;

      // Detect if cwd is inside a managed repo → inject connections + references
      const cwd = ctx.cwd;
      const index = loadIndex(config);
      const paths = getPaths(config);

      let cwdEntry: typeof index.repos[0] | undefined;
      for (const entry of index.repos) {
        const repoStoragePath = join(paths.repos, entry.host, entry.owner, entry.name);
        const matchPath = entry.type === "cloned" ? repoStoragePath : entry.path;
        if (cwd.startsWith(matchPath + "/") || cwd === matchPath) {
          cwdEntry = entry;
          break;
        }
      }

      if (cwdEntry) {
        const cwdId = repoId(cwdEntry);
        cwdRepoId = cwdId;
        const contextLines: string[] = [];

        // Find all groups this repo belongs to
        const allGroups = listGroups(config);
        for (const groupName of allGroups) {
          try {
            const group = getGroupInfo(config, groupName);
            if (!group.repos.includes(cwdId)) continue;

            const workspacePath = expandTilde(join(getPaths(config).groups, groupName, "docs"));
            contextLines.push(`## Group: ${groupName}`);
            contextLines.push(`Workspace: \`${workspacePath}\``);
            contextLines.push("");

            // Connections (both directions)
            if (group.connections.length > 0) {
              contextLines.push("### Connections");
              contextLines.push("");
              for (const conn of group.connections) {
                const isOutbound = conn.from === cwdId;
                const isInbound = conn.to === cwdId;
                if (!isOutbound && !isInbound) continue;

                const otherRepoId = isOutbound ? conn.to : conn.from;
                const arrow = isOutbound ? "→" : "←";
                const desc = conn.description ? ` — ${conn.description}` : "";

                // Resolve the connected repo's default worktree path.
                let repoPath = "";
                try {
                  const otherEntry = resolveRepo(index, otherRepoId);
                  const defaultWt = otherEntry.worktrees.find(w => w.branch === otherEntry.defaultBranch);
                  repoPath = defaultWt?.path ?? (otherEntry.type === "local" ? otherEntry.path : "");
                } catch { /* repo not in index */ }

                contextLines.push(`${arrow} **${conn.relationship}**: \`${otherRepoId}\`${desc}`);
                if (repoPath) contextLines.push(`  Path: \`${repoPath}\``);
                contextLines.push("");
              }
            }

            // Group-level references
            if (group.references && group.references.length > 0) {
              contextLines.push("### Group References");
              contextLines.push("");
              for (const ref of group.references) {
                const tag = ref.tag ? ` @${ref.tag}` : "";
                const reason = ref.reason ? ` — ${ref.reason}` : "";
                let refPath = "";
                try {
                  const refEntry = resolveRepo(index, ref.repo);
                  const defaultWt = refEntry.worktrees.find(w => w.branch === refEntry.defaultBranch);
                  refPath = defaultWt?.path ?? (refEntry.type === "local" ? refEntry.path : "");
                } catch { /* not in index */ }
                contextLines.push(`- \`${ref.repo}\`${tag}${reason}`);
                if (refPath) contextLines.push(`  Path: \`${refPath}\``);
              }
              contextLines.push("");
            }
          } catch { /* group load failed */ }
        }

        // Repo-level references
        if (cwdEntry.references && cwdEntry.references.length > 0) {
          contextLines.push("## Repo References");
          contextLines.push("");
          for (const ref of cwdEntry.references) {
            const tag = ref.tag ? ` @${ref.tag}` : "";
            const reason = ref.reason ? ` — ${ref.reason}` : "";
            let refPath = "";
            try {
              const refEntry = resolveRepo(index, ref.repo);
              const defaultWt = refEntry.worktrees.find(w => w.branch === refEntry.defaultBranch);
              refPath = defaultWt?.path ?? (refEntry.type === "local" ? refEntry.path : "");
            } catch { /* not in index */ }
            contextLines.push(`- \`${ref.repo}\`${tag}${reason}`);
            if (refPath) contextLines.push(`  Path: \`${refPath}\``);
          }
          contextLines.push("");
        }

        // Inject if we have anything meaningful and this branch has not seen it.
        if (
          contextLines.length > 0 &&
          !hasStartupContextMarker(ctx.sessionManager.getBranch(), cwdId)
        ) {
          const header = [
            "# pi-repos: Related Repositories",
            "",
            `You are working in \`${cwdId}\`. The repos below are locally available and connected to this project.`,
            "Use \`read\` / \`grep\` directly on the listed paths — no need to clone or fetch.",
            "For deeper context (full summaries, annotations), use \`repos_info\` or \`repos_group info\`.",
            "Group docs (architecture.md, roles.md, etc.) are at the workspace path — read them when you need system-level understanding.",
            "",
          ].join("\n");

          pi.sendMessage({
            customType: "pi-repos-context",
            content: header + contextLines.join("\n"),
            display: false,
          }, { triggerTurn: false });
          pi.appendEntry(STARTUP_CONTEXT_MARKER, { repoId: cwdId });
        }
      }
    } catch (err: any) {
      ctx.ui.notify(`pi-repos: init failed: ${err.message}`, "warning");
    }
  });

  // Auto-inject TL;DR when agent reads files inside a managed repo (once per repo per session)
  pi.on("tool_result", async (event, ctx) => {
    const ev = event as any;
    const toolName: string = ev.toolName ?? "";
    if (toolName !== "read" && toolName !== "grep" && toolName !== "find") return;

    const filePath: string | undefined =
      typeof ev.input?.path === "string" ? ev.input.path : undefined;
    if (!filePath) return;

    try {
      const index = loadIndex(config);
      const paths = getPaths(config);

      for (const entry of index.repos) {
        const id = repoId(entry);
        if (id === cwdRepoId || injectedRepos.has(id)) continue;

        const repoStoragePath = join(paths.repos, entry.host, entry.owner, entry.name);
        const matchPath = entry.type === "cloned" ? repoStoragePath : entry.path;

        if (filePath.startsWith(matchPath + "/") || filePath === matchPath) {
          injectedRepos.add(id);
          const summary = readSummary(repoMetaDir(config, entry));
          if (summary?.tldr) {
            const context = buildRepoSummaryContext(id, summary.tldr);
            pi.sendMessage({
              customType: "pi-repos-context",
              content: context.content,
              display: false,
            }, { triggerTurn: false });
          }
          pi.appendEntry(REPO_CONTEXT_MARKER, { repoId: id });
          break;
        }
      }
    } catch {
      // Never crash on tool_result
    }
  });



  // ─── Tools ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "repos_add",
    label: "Repos: Add",
    description:
      "Clone a repository by URL or register a local path. " +
      "Accepts tags, group assignment, and starred flag.",
    promptSnippet: "repos_add — clone URL or register local repo",
    parameters: Type.Object({
      url:     Type.Optional(Type.String({ description: "Clone URL (https:// or git@)" })),
      local:   Type.Optional(Type.String({ description: "Absolute path to existing local repo" })),
      tags:    Type.Optional(Type.Array(Type.String(), { description: "Tags to assign" })),
      group:   Type.Optional(Type.String({ description: "Group name to add this repo to" })),
      starred: Type.Optional(Type.Boolean({ description: "Pin as starred" })),
      tag:     Type.Optional(Type.String({ description: "Clone at a specific tag or ref (creates detached worktree)" })),
      wiki:    Type.Optional(Type.Boolean({ description: "Also generate gitnexus wiki (LLM-heavy, slower)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      if (!p.url && !p.local) {
        return ok("repos_add: must provide either 'url' or 'local'");
      }
      try {
        const entry = p.url
          ? await cloneRepo(config, p.url, p.tags, p.starred, p.tag)
          : await registerLocal(config, p.local, p.tags, p.starred);
        const out: AddOutput = {
          repo:            repoId(entry),
          type:            entry.type,
          path:            entry.path,
          tags:            entry.tags,
          autoTags:        entry.autoTags,
          message:         `Added ${repoId(entry)} (${entry.type})${entry.pinnedRef ? ` @${entry.pinnedRef}` : ''}`,
          ...(entry.pinnedRef ? { pinnedRef: entry.pinnedRef } : {}),
        };
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_add failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_info",
    label: "Repos: Info",
    description:
      "Full details for a repo: path, worktrees, TL;DR, full summary, annotations, " +
      "and freshness (commits behind, last sync). " +
      "Pass regenerate:true to re-generate the TL;DR.",
    promptSnippet: "repos_info — full details + TL;DR for a repo",
    parameters: Type.Object({
      repo:       Type.String({ description: "Repo identifier: owner/repo or host/owner/repo" }),
      regenerate: Type.Optional(Type.Boolean({ description: "Re-generate TL;DR even if cached" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        const info = await getRepoInfo(config, p.repo, p.regenerate ?? false);
        return ok(JSON.stringify(info, null, 2));
      } catch (err: any) {
        return ok(`repos_info failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_list",
    label: "Repos: List",
    description:
      "List all managed repos with freshness indicators (last sync, commits behind, index staleness). " +
      "Filter by group, tag, starred, or query. Default output is compact (id + path only); use verbose for full details.",
    promptSnippet: "repos_list — all repos with freshness",
    parameters: Type.Object({
      group:   Type.Optional(Type.String({ description: "Filter by group name" })),
      tag:     Type.Optional(Type.String({ description: "Filter by tag" })),
      starred: Type.Optional(Type.Boolean({ description: "Show only starred repos" })),
      query:   Type.Optional(Type.String({ description: "Case-insensitive substring match on repo id" })),
      verbose: Type.Optional(Type.Boolean({ description: "Include full details (type, tags, freshness, tldr). Default: false (compact: id + path only)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        const repos = await listRepos(config, {
          group:   p.group,
          tag:     p.tag,
          starred: p.starred,
          query:   p.query,
          verbose: p.verbose,
        });
        const out: ListOutput = { repos, total: repos.length } as ListOutput;
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_list failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_remove",
    label: "Repos: Remove",
    description:
      "Remove a repo from the index. " +
      "Cloned repos: deletes the storage directory. " +
      "Local repos: removes only the index entry — the actual directory is NEVER deleted.",
    promptSnippet: "repos_remove — remove repo from index",
    parameters: Type.Object({
      repo: Type.String({ description: "Repo identifier: owner/repo or host/owner/repo" }),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        const result = await removeRepo(config, p.repo);
        const out: RemoveOutput = {
          ...result,
          message: result.storageDeleted
            ? `Removed ${result.removed} and deleted cloned storage`
            : `Removed ${result.removed} from index (local directory preserved)`,
        };
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_remove failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_search",
    label: "Repos: Search",
    description:
      "Search repo contents with ripgrep. Scope to a specific repo or group.",
    promptSnippet: "repos_search — ripgrep across repos",
    parameters: Type.Object({
      pattern:       Type.String({ description: "Search pattern (regex)" }),
      repo:          Type.Optional(Type.String({ description: "Scope to owner/repo" })),
      group:         Type.Optional(Type.String({ description: "Scope to group" })),
      glob:          Type.Optional(Type.String({ description: "File glob filter (e.g. '*.go')" })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive search (default false)" })),
      limit:         Type.Optional(Type.Number({ description: "Max results (default 50)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        const out = await searchRepos(config, p.pattern, {
          repo:          p.repo,
          group:         p.group,
          glob:          p.glob,
          caseSensitive: p.caseSensitive,
          limit:         p.limit,
        });
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_search failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_annotate",
    label: "Repos: Annotate",
    description:
      "Append a knowledge note to a repo or group. " +
      "Categories:\n" +
      "- architecture: structural decisions, module boundaries, data flow\n" +
      "- pattern: reusable idioms, conventions found in the codebase\n" +
      "- bug: known bugs, gotchas, footguns, workarounds\n" +
      "- decision: design decisions with rationale (ADR-lite)\n" +
      "- cross-cutting: observations spanning multiple repos or modules\n" +
      "Exactly one of repo or group must be specified.",
    promptSnippet: "repos_annotate — append knowledge note to repo or group",
    parameters: Type.Object({
      repo:     Type.Optional(Type.String({ description: "Target repo (owner/repo)" })),
      group:    Type.Optional(Type.String({ description: "Target group name" })),
      category: Type.String({ description: "architecture | pattern | bug | decision | cross-cutting" }),
      content:  Type.String({ description: "Markdown annotation content" }),
      files:    Type.Optional(Type.Array(Type.String(), { description: "Related file paths" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      if (!p.repo && !p.group) return ok("repos_annotate: must specify exactly one of 'repo' or 'group'");
      if (p.repo && p.group)  return ok("repos_annotate: cannot specify both 'repo' and 'group'");
      try {
        let notesPath: string;
        let target: string;
        if (p.repo) {
          const index = loadIndex(config);
          const entry = resolveRepo(index, p.repo);
          notesPath = `${repoMetaDir(config, entry)}/notes.md`;
          target = repoId(entry);
        } else {
          notesPath = `${groupDir(config, p.group)}/notes.md`;
          target = `group:${p.group}`;
        }
        const annotation = {
          category:  p.category,
          content:   p.content,
          timestamp: new Date().toISOString(),
          files:     p.files,
        };
        appendAnnotation(notesPath, annotation);
        const out: AnnotateOutput = {
          target,
          category: p.category,
          message: `Annotation added to ${target}`,
        };
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_annotate failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_group",
    label: "Repos: Group",
    description:
      "Manage repo groups. Actions:\n" +
      "- create: create group with optional repos and description\n" +
      "- add: add a repo to an existing group\n" +
      "- remove: remove repo from group (or delete group if no repo specified)\n" +
      "- info: full group details including connections\n" +
      "- connect: add a directional relationship between two repos\n" +
      "- suggest: AI-suggest connections based on member TL;DRs (returns suggestions, does not persist)\n" +
      "- docs: list/read/write group-level documentation files\n" +
      "- sync: fetch all member repos + trigger gitnexus group sync if available",
    promptSnippet: "repos_group — group CRUD, connections, docs, sync",
    parameters: Type.Object({
      action:      Type.String({ description: "create | add | remove | info | connect | suggest | docs | sync" }),
      name:        Type.String({ description: "Group name" }),
      repo:        Type.Optional(Type.String({ description: "Repo identifier (for add/remove)" })),
      description: Type.Optional(Type.String({ description: "Group description (for create)" })),
      repos:       Type.Optional(Type.Array(Type.String(), { description: "Initial members (for create)" })),
      from:        Type.Optional(Type.String({ description: "Source repo (for connect)" })),
      to:          Type.Optional(Type.String({ description: "Target repo (for connect)" })),
      relationship: Type.Optional(Type.String({ description: "deploys-to | depends-on | configures | shared-lib | imports | consumes | custom" })),
      docAction:   Type.Optional(Type.String({ description: "list | read | write (for docs)" })),
      docPath:     Type.Optional(Type.String({ description: "Doc filename (for docs)" })),
      docContent:  Type.Optional(Type.String({ description: "Doc content (for docs write)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        switch (p.action) {
          case "create": {
            const group = createGroup(config, p.name, p.description, p.repos);
            // Fire-and-forget: generate group docs if members were provided
            if (p.repos && p.repos.length > 0) {
              generateGroupDocs(config, p.name).catch(() => {});
            }
            const out: GroupOutput = { action: "create", group, message: `Group "${p.name}" created` };
            return ok(JSON.stringify(out, null, 2));
          }
          case "add": {
            const group = addToGroup(config, p.name, p.repo);
            const out: GroupOutput = { action: "add", group, message: `Added ${p.repo} to group "${p.name}"` };
            return ok(JSON.stringify(out, null, 2));
          }
          case "remove": {
            const result = await removeFromGroup(config, p.name, p.repo);
            const out: GroupOutput = {
              action: "remove",
              group: null,
              message: result.action === "group-deleted"
                ? `Group "${p.name}" deleted`
                : `Removed ${p.repo} from group "${p.name}"`,
            };
            return ok(JSON.stringify(out, null, 2));
          }
          case "info": {
            const group = getGroupInfo(config, p.name);
            const out: GroupOutput = { action: "info", group, message: `Group "${p.name}"` };
            return ok(JSON.stringify(out, null, 2));
          }
          case "connect": {
            const group = connectRepos(config, p.name, p.from, p.to, p.relationship, p.description);
            // Fire-and-forget: regenerate group docs on connection change
            generateGroupDocs(config, p.name).catch(() => {});
            const out: GroupOutput = {
              action: "connect",
              group,
              message: `Connected ${p.from} --[${p.relationship}]--> ${p.to} in group "${p.name}"`,
            };
            return ok(JSON.stringify(out, null, 2));
          }
          case "docs": {
            if (p.docAction === "regenerate") {
              const result = await generateGroupDocs(config, p.name);
              return ok(JSON.stringify({
                action: "docs",
                group: null,
                message: result.generated.length > 0
                  ? `Regenerated ${result.generated.join(", ")} for group "${p.name}"`
                  : `No docs generated for group "${p.name}"`,
                docs: result.generated,
                errors: result.errors.length > 0 ? result.errors : undefined,
              }, null, 2));
            }
            const result = manageDocs(config, p.name, p.docAction ?? "list", p.docPath, p.docContent);
            const out: GroupOutput = {
              action: "docs",
              group: null,
              message: `docs ${p.docAction ?? "list"} on group "${p.name}"`,
              docContent: result.content,
              docs: result.docs,
            };
            return ok(JSON.stringify(out, null, 2));
          }
          case "sync": {
            const synced = await syncGroup(config, p.name);
            const out: GroupOutput = {
              action: "sync",
              group: null,
              message: `Synced ${synced.length} repo(s) in group "${p.name}"`,
            };
            return ok(JSON.stringify(out, null, 2));
          }
          case "suggest": {
            const suggestions = await suggestConnections(config, p.name);
            return ok(JSON.stringify({
              action: "suggest",
              group: p.name,
              suggestions,
              message: suggestions.length > 0
                ? `${suggestions.length} connection(s) suggested for group "${p.name}". Review and confirm with repos_group connect.`
                : `No new connections suggested for group "${p.name}".`,
            }, null, 2));
          }
          default:
            return ok(`repos_group: unknown action "${p.action}". Valid: create|add|remove|info|connect|docs|sync`);
        }
      } catch (err: any) {
        return ok(`repos_group failed: ${err.message}`);
      }
    },
  });

  // ─── repos_annotate (reference management via separate tool) ────────────────

  pi.registerTool({
    name: "repos_reference",
    label: "Repos: Reference",
    description:
      "Manage references on repos or groups. References are unidirectional pointers " +
      "to other repos for context (e.g., 'this repo uses kro for CRD API shapes'). " +
      "Actions: add (add a reference), remove (remove a reference), list (show references).\n" +
      "Referenced repos must exist in the pi-repos index.",
    promptSnippet: "repos_reference — manage context references on repos/groups",
    parameters: Type.Object({
      action:  Type.String({ description: "add | remove | list" }),
      repo:    Type.Optional(Type.String({ description: "Target repo to manage references on" })),
      group:   Type.Optional(Type.String({ description: "Target group to manage references on" })),
      target:  Type.Optional(Type.String({ description: "Referenced repo ID (for add/remove)" })),
      tag:     Type.Optional(Type.String({ description: "Pinned version/tag for the reference" })),
      reason:  Type.Optional(Type.String({ description: "Why this is referenced" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      if (!p.repo && !p.group) return ok("repos_reference: must specify either 'repo' or 'group'");
      if (p.repo && p.group)  return ok("repos_reference: cannot specify both 'repo' and 'group'");

      try {
        if (p.action === "list") {
          if (p.repo) {
            const index = loadIndex(config);
            const entry = resolveRepo(index, p.repo);
            return ok(JSON.stringify({ repo: repoId(entry), references: entry.references ?? [] }, null, 2));
          } else {
            const group = getGroupInfo(config, p.group);
            return ok(JSON.stringify({ group: group.name, references: group.references ?? [] }, null, 2));
          }
        }

        if (p.action === "add") {
          if (!p.target) return ok("repos_reference add: 'target' is required");
          const ref: Reference = { repo: p.target };
          if (p.tag) ref.tag = p.tag;
          if (p.reason) ref.reason = p.reason;

          if (p.repo) {
            const index = loadIndex(config);
            const entry = resolveRepo(index, p.repo);
            addReference(index, entry, ref);
            saveIndex(config, index);
            return ok(JSON.stringify({
              message: `Reference to ${p.target} added on ${repoId(entry)}`,
              references: entry.references,
            }, null, 2));
          } else {
            const group = addGroupReference(config, p.group, ref);
            return ok(JSON.stringify({
              message: `Reference to ${p.target} added on group "${p.group}"`,
              references: group.references,
            }, null, 2));
          }
        }

        if (p.action === "remove") {
          if (!p.target) return ok("repos_reference remove: 'target' is required");

          if (p.repo) {
            const index = loadIndex(config);
            const entry = resolveRepo(index, p.repo);
            const removed = removeReference(entry, p.target);
            if (removed) saveIndex(config, index);
            return ok(JSON.stringify({
              message: removed
                ? `Reference to ${p.target} removed from ${repoId(entry)}`
                : `No reference to ${p.target} found on ${repoId(entry)}`,
              references: entry.references ?? [],
            }, null, 2));
          } else {
            const group = removeGroupReference(config, p.group, p.target);
            return ok(JSON.stringify({
              message: `Reference to ${p.target} removed from group "${p.group}"`,
              references: group.references ?? [],
            }, null, 2));
          }
        }

        return ok(`repos_reference: unknown action "${p.action}". Valid: add|remove|list`);
      } catch (err: any) {
        return ok(`repos_reference failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "repos_sync",
    label: "Repos: Sync",
    description:
      "Fetch latest changes and update freshness. " +
      "Scope to a specific repo, a group, or all managed repos.",
    promptSnippet: "repos_sync — fetch latest changes",
    parameters: Type.Object({
      repo:  Type.Optional(Type.String({ description: "Sync a specific repo" })),
      group: Type.Optional(Type.String({ description: "Sync all repos in a group" })),
      all:   Type.Optional(Type.Boolean({ description: "Sync all managed repos" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx): Promise<ToolResult> {
      const p = params as any;
      try {
        const index = loadIndex(config);
        let targets;
        if (p.repo) {
          targets = [resolveRepo(index, p.repo)];
        } else if (p.group) {
          const groupJson = join(getPaths(config).groups, p.group, "group.json");
          if (!existsSync(groupJson)) {
            return ok(`repos_sync: group not found: ${p.group}`);
          }
          const group = JSON.parse(readFileSync(groupJson, "utf-8"));
          targets = (group.repos ?? []).flatMap((id: string) => {
            try { return [resolveRepo(index, id)]; } catch { return []; }
          });
        } else {
          targets = index.repos;
        }
        const synced = await Promise.all(
          targets.map(async (entry: any) => {
            const r = await syncRepo(config, entry);
            return { repo: repoId(entry), ...r };
          }),
        );
        const out: SyncOutput = {
          synced,
          total:   synced.length,
          message: `Synced ${synced.length} repo(s)`,
        };
        return ok(JSON.stringify(out, null, 2));
      } catch (err: any) {
        return ok(`repos_sync failed: ${err.message}`);
      }
    },
  });
}
