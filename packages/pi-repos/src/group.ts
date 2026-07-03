/**
 * pi-repos — Group management: CRUD, connections, docs, sync.
 *
 * Storage per group at groups/{name}/:
 *   group.json       — canonical data (RepoGroup)
 *   README.md        — auto-generated overview
 *   connections.md   — auto-generated from connections array
 *   notes.md         — group-level annotations (written by repos_annotate)
 *   docs/            — arbitrary user-managed markdown files
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { RepoEntry, RepoGroup, Connection, ConnectionRelationship, ReposConfig, Reference } from "./types.js";
import { getPaths } from "./config.js";
import { loadIndex, groupDir, resolveRepo, repoId } from "./storage.js";
import { syncRepo } from "./clone.js";

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Load a group's data from group.json. Throws if not found. */
function loadGroup(config: ReposConfig, name: string): RepoGroup {
  const dir  = groupDir(config, name);
  const file = join(dir, "group.json");
  if (!existsSync(file)) throw new Error(`Group not found: "${name}"`);
  return JSON.parse(readFileSync(file, "utf-8")) as RepoGroup;
}

/** Persist a group's data and regenerate derived markdown files. */
function saveGroup(config: ReposConfig, group: RepoGroup): void {
  const dir = groupDir(config, group.name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  writeFileSync(join(dir, "group.json"), JSON.stringify(group, null, 2), "utf-8");
  writeFileSync(join(dir, "README.md"), generateReadme(group), "utf-8");
}

// ─── Markdown Generation ─────────────────────────────────────────────────────

/** Auto-generate a README for the group (minimal — detailed docs live in docs/). */
function generateReadme(group: RepoGroup): string {
  const lines = [
    `# ${group.name}`,
    "",
    group.description || "_No description._",
    "",
    `## Members (${group.repos.length})`,
    "",
    ...group.repos.map(r => `- \`${r}\``),
  ];

  if (group.references && group.references.length > 0) {
    lines.push("", `## References (${group.references.length})`, "");
    for (const ref of group.references) {
      const tag = ref.tag ? ` @${ref.tag}` : "";
      const reason = ref.reason ? ` — ${ref.reason}` : "";
      lines.push(`- \`${ref.repo}\`${tag}${reason}`);
    }
  }

  if (group.connections.length > 0) {
    lines.push("", `## Connections (${group.connections.length})`, "");
    for (const c of group.connections) {
      const desc = c.description ? ` — ${c.description}` : "";
      lines.push(`- \`${c.from}\` **${c.relationship}** \`${c.to}\`${desc}`);
    }
  }

  lines.push("", "_See `docs/` for architecture, roles, glossary, and dependency map._");
  lines.push("", `_Updated: ${group.updated}_`);
  return lines.join("\n") + "\n";
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a new group. Throws if it already exists.
 * `repos` entries are validated against the index.
 */
export function createGroup(
  config: ReposConfig,
  name: string,
  description = "",
  repos: string[] = [],
): RepoGroup {
  const dir = groupDir(config, name);
  if (existsSync(join(dir, "group.json"))) {
    throw new Error(`Group already exists: "${name}"`);
  }

  // Validate all repo identifiers exist in index
  const index = loadIndex(config);
  for (const r of repos) {
    resolveRepo(index, r); // throws if not found
  }

  const now = new Date().toISOString();
  const group: RepoGroup = {
    name,
    description,
    repos: repos.map(r => repoId(resolveRepo(index, r))),
    connections: [],
    created: now,
    updated: now,
  };

  saveGroup(config, group);
  return group;
}

/**
 * Add a repo to an existing group. Idempotent.
 */
export function addToGroup(config: ReposConfig, name: string, repo: string): RepoGroup {
  const index = loadIndex(config);
  const entry = resolveRepo(index, repo);
  const id    = repoId(entry);
  const group = loadGroup(config, name);

  if (!group.repos.includes(id)) {
    group.repos.push(id);
    group.updated = new Date().toISOString();
    saveGroup(config, group);
  }

  return group;
}

/**
 * Remove a repo from a group, or delete the entire group if no repo specified.
 */
export async function removeFromGroup(
  config: ReposConfig,
  name: string,
  repo?: string,
): Promise<{ action: "repo-removed" | "group-deleted"; name: string }> {
  if (!repo) {
    // Delete entire group directory
    const dir = groupDir(config, name);
    if (!existsSync(dir)) throw new Error(`Group not found: "${name}"`);
    await rm(dir, { recursive: true, force: true });
    return { action: "group-deleted", name };
  }

  const index = loadIndex(config);
  const entry = resolveRepo(index, repo);
  const id    = repoId(entry);
  const group = loadGroup(config, name);

  group.repos     = group.repos.filter(r => r !== id);
  // Also remove any connections referencing this repo
  group.connections = group.connections.filter(c => c.from !== id && c.to !== id);
  group.updated   = new Date().toISOString();
  saveGroup(config, group);

  return { action: "repo-removed", name };
}

/**
 * Get full group info.
 */
export function getGroupInfo(config: ReposConfig, name: string): RepoGroup {
  return loadGroup(config, name);
}

/**
 * Resolve group member identifiers to full RepoEntry objects.
 * Members not found in the index are silently skipped.
 */
export function getGroupMembers(config: ReposConfig, name: string): RepoEntry[] {
  const group = loadGroup(config, name);
  const index = loadIndex(config);
  const members: RepoEntry[] = [];

  for (const id of group.repos) {
    try {
      members.push(resolveRepo(index, id));
    } catch {
      // Index entry was removed; skip
    }
  }

  return members;
}

// ─── Connections ─────────────────────────────────────────────────────────────

/**
 * Add a connection between two repos in a group.
 * Duplicate connections (same from/to/relationship) are ignored.
 */
export function connectRepos(
  config: ReposConfig,
  name: string,
  from: string,
  to: string,
  relationship: ConnectionRelationship,
  description?: string,
): RepoGroup {
  const index = loadIndex(config);

  // Validate both repos exist (fuzzy or exact)
  const fromId = repoId(resolveRepo(index, from));
  const toId   = repoId(resolveRepo(index, to));

  const group = loadGroup(config, name);

  const duplicate = group.connections.some(
    c => c.from === fromId && c.to === toId && c.relationship === relationship,
  );
  if (!duplicate) {
    const conn: Connection = { from: fromId, to: toId, relationship };
    if (description) conn.description = description;
    group.connections.push(conn);
    group.updated = new Date().toISOString();
    saveGroup(config, group);
  }

  return group;
}

// ─── Docs ────────────────────────────────────────────────────────────────────

/**
 * Manage group-level documentation files in docs/.
 */
export function manageDocs(
  config: ReposConfig,
  name: string,
  action: "list" | "read" | "write",
  docPath?: string,
  content?: string,
): { docs?: string[]; content?: string } {
  const dir     = groupDir(config, name);
  const docsDir = join(dir, "docs");

  // Ensure group exists
  if (!existsSync(join(dir, "group.json"))) {
    throw new Error(`Group not found: "${name}"`);
  }

  mkdirSync(docsDir, { recursive: true });

  if (action === "list") {
    const entries = existsSync(docsDir)
      ? readdirSync(docsDir).filter(f => f.endsWith(".md"))
      : [];
    return { docs: entries };
  }

  if (action === "read") {
    if (!docPath) throw new Error("docPath is required for read action");
    const filePath = join(docsDir, docPath.endsWith(".md") ? docPath : `${docPath}.md`);
    if (!existsSync(filePath)) throw new Error(`Doc not found: "${docPath}"`);
    return { content: readFileSync(filePath, "utf-8") };
  }

  if (action === "write") {
    if (!docPath)  throw new Error("docPath is required for write action");
    if (content === undefined) throw new Error("content is required for write action");
    const filePath = join(docsDir, docPath.endsWith(".md") ? docPath : `${docPath}.md`);
    writeFileSync(filePath, content, "utf-8");
    return {};
  }

  throw new Error(`Unknown doc action: "${action}"`);
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Sync all repos in a group (git fetch).
 */
export async function syncGroup(
  config: ReposConfig,
  name: string,
): Promise<Array<{ repo: string; fetched: boolean; error?: string }>> {
  const members = getGroupMembers(config, name);
  const results: Array<{ repo: string; fetched: boolean; error?: string }> = [];

  for (const entry of members) {
    const id = repoId(entry);
    try {
      const r = await syncRepo(config, entry);
      results.push({ repo: id, ...r });
    } catch (err: any) {
      results.push({ repo: id, fetched: false, error: err.message });
    }
  }

  return results;
}

// ─── List All Groups ─────────────────────────────────────────────────────────

/** Return all group names that have a group.json. */
export function listGroups(config: ReposConfig): string[] {
  const paths = getPaths(config);
  if (!existsSync(paths.groups)) return [];

  return readdirSync(paths.groups, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(paths.groups, d.name, "group.json")))
    .map(d => d.name);
}

// ─── Group References ──────────────────────────────────────────────────────────

/**
 * Add a reference to a group. Validates target repo exists in index.
 * Idempotent: duplicate (same repo ID) updates tag/reason.
 */
export function addGroupReference(config: ReposConfig, name: string, ref: Reference): RepoGroup {
  const index = loadIndex(config);
  // Validate target repo exists
  resolveRepo(index, ref.repo);

  const group = loadGroup(config, name);
  if (!group.references) group.references = [];

  const existing = group.references.find(r => r.repo === ref.repo);
  if (existing) {
    if (ref.tag !== undefined) existing.tag = ref.tag;
    if (ref.reason !== undefined) existing.reason = ref.reason;
  } else {
    group.references.push({ ...ref });
  }

  group.updated = new Date().toISOString();
  saveGroup(config, group);
  return group;
}

/**
 * Remove a reference from a group by repo ID.
 * Returns updated group. Throws if group not found.
 */
export function removeGroupReference(config: ReposConfig, name: string, repoIdentifier: string): RepoGroup {
  const group = loadGroup(config, name);
  if (!group.references) return group;

  group.references = group.references.filter(r => r.repo !== repoIdentifier);
  if (group.references.length === 0) delete group.references;

  group.updated = new Date().toISOString();
  saveGroup(config, group);
  return group;
}
