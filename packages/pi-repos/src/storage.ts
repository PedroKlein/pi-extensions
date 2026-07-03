/**
 * pi-repos — Storage: directory creation, repo index, resolution, annotations, summaries.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { RepoEntry, Annotation, AnnotationCategory, Summary, ReposConfig, Reference } from "./types.js";
import { getPaths, expandTilde } from "./config.js";

// ─── Directory Management ────────────────────────────────────────────────────

/** Ensure base storage layout exists. Safe to call repeatedly. */
export function ensureStorageDirs(config: ReposConfig): void {
  const p = getPaths(config);
  for (const dir of [p.base, p.repos, p.groups]) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─── Repo Index ──────────────────────────────────────────────────────────────

export interface RepoIndex {
  repos: RepoEntry[];
}

export function loadIndex(config: ReposConfig): RepoIndex {
  const p = getPaths(config);
  try {
    const raw = readFileSync(p.index, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.repos)) return parsed as RepoIndex;
  } catch {
    // missing or corrupt
  }
  return { repos: [] };
}

export function saveIndex(config: ReposConfig, index: RepoIndex): void {
  const p = getPaths(config);
  mkdirSync(dirname(p.index), { recursive: true });
  writeFileSync(p.index, JSON.stringify(index, null, 2), "utf-8");
}

// ─── Repo Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a repo identifier to an entry.
 * - "host/owner/repo"  → exact match
 * - "owner/repo"       → search all hosts; throw on conflict or missing
 */
export function resolveRepo(index: RepoIndex, identifier: string): RepoEntry {
  const parts = identifier.split("/");

  if (parts.length === 3) {
    const [host, owner, name] = parts;
    const entry = index.repos.find(r => r.host === host && r.owner === owner && r.name === name);
    if (!entry) throw new Error(`Repo not found: ${identifier}`);
    return entry;
  }

  if (parts.length === 2) {
    const [owner, name] = parts;
    const matches = index.repos.filter(r => r.owner === owner && r.name === name);
    if (matches.length === 0) throw new Error(`Repo not found: ${identifier}`);
    if (matches.length > 1) {
      const hosts = matches.map(r => r.host).join(", ");
      throw new Error(
        `Ambiguous identifier "${identifier}" matches multiple hosts: ${hosts}. ` +
        `Use host/owner/repo to disambiguate.`
      );
    }
    return matches[0];
  }

  throw new Error(
    `Invalid repo identifier "${identifier}". Expected "owner/repo" or "host/owner/repo".`
  );
}

/** Canonical string identifier for a repo entry. */
export function repoId(entry: RepoEntry): string {
  return `${entry.host}/${entry.owner}/${entry.name}`;
}

// ─── Path Helpers ────────────────────────────────────────────────────────────

/** Metadata directory for a specific repo (.meta/ inside the repo storage dir). */
export function repoMetaDir(config: ReposConfig, entry: RepoEntry): string {
  return join(getPaths(config).repos, entry.host, entry.owner, entry.name, ".meta");
}

/** Directory for a named group. */
export function groupDir(config: ReposConfig, groupName: string): string {
  return join(getPaths(config).groups, groupName);
}

// ─── Annotations ────────────────────────────────────────────────────────────

/**
 * Append an annotation as a YAML-frontmatter + markdown block to notes.md.
 */
export function appendAnnotation(notesPath: string, annotation: Annotation): void {
  mkdirSync(dirname(notesPath), { recursive: true });

  const filesLine = annotation.files?.length
    ? `files: [${annotation.files.map(f => `"${f}"`).join(", ")}]\n`
    : "";

  const block =
    `\n---\n` +
    `category: ${annotation.category}\n` +
    `timestamp: ${annotation.timestamp}\n` +
    filesLine +
    `---\n\n` +
    `${annotation.content}\n`;

  appendFileSync(notesPath, block, "utf-8");
}

/**
 * Parse all annotations from a notes.md file.
 */
export function readAnnotations(notesPath: string): Annotation[] {
  if (!existsSync(notesPath)) return [];

  const raw = readFileSync(notesPath, "utf-8");
  const annotations: Annotation[] = [];

  // Each block is delimited by ---\n...---\n\n<content>
  const blockRe = /---\n([\s\S]*?)---\n([\s\S]*?)(?=\n---|$)/g;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(raw)) !== null) {
    const fm = m[1];
    const content = m[2].trim();

    const category = fm.match(/category:\s*(.+)/)?.[1]?.trim() as AnnotationCategory | undefined;
    const timestamp = fm.match(/timestamp:\s*(.+)/)?.[1]?.trim() ?? "";
    const filesRaw = fm.match(/files:\s*\[(.+)\]/)?.[1];
    const files = filesRaw
      ? filesRaw.split(",").map(f => f.trim().replace(/^"|"$/g, ""))
      : undefined;

    if (category) {
      annotations.push({ category, content, timestamp, files });
    }
  }

  return annotations;
}

// ─── Summary / TL;DR ────────────────────────────────────────────────────────

/** Read stored TL;DR + full summary (staleness determined externally). */
export function readSummary(metaDir: string): Summary | null {
  const tldrPath   = join(metaDir, "tldr.md");
  const revPath    = join(metaDir, "rev.txt");
  const summaryPath = join(metaDir, "summary.md");

  if (!existsSync(tldrPath)) return null;

  return {
    tldr:  readFileSync(tldrPath, "utf-8").trim(),
    full:  existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8").trim() : undefined,
    rev:   existsSync(revPath)     ? readFileSync(revPath, "utf-8").trim()     : "",
    stale: false, // caller must compare rev vs HEAD
  };
}

export function writeTldr(metaDir: string, tldr: string, rev: string): void {
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, "tldr.md"), tldr, "utf-8");
  writeFileSync(join(metaDir, "rev.txt"), rev,  "utf-8");
}

export function writeSummary(metaDir: string, summary: string): void {
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, "summary.md"), summary, "utf-8");
}

// ─── Tag / Star Helpers ──────────────────────────────────────────────────────

/** Replace entry tags (mutates in place; call saveIndex after). */
export function setTags(entry: RepoEntry, tags: string[]): void {
  entry.tags = [...new Set(tags)];
}

/** Set starred status (mutates in place; call saveIndex after). */
export function setStarred(entry: RepoEntry, starred: boolean): void {
  entry.starred = starred;
}

// ─── References ──────────────────────────────────────────────────────────────

/**
 * Add a reference to a repo entry. Validates target exists in index.
 * Idempotent: duplicate (same repo ID) is a no-op (updates tag/reason if changed).
 * Mutates entry in place — call saveIndex after.
 */
export function addReference(
  index: { repos: RepoEntry[] },
  entry: RepoEntry,
  ref: Reference,
): void {
  // Validate target repo exists
  resolveRepo(index, ref.repo);

  if (!entry.references) entry.references = [];

  const existing = entry.references.find(r => r.repo === ref.repo);
  if (existing) {
    // Update tag/reason if provided
    if (ref.tag !== undefined) existing.tag = ref.tag;
    if (ref.reason !== undefined) existing.reason = ref.reason;
  } else {
    entry.references.push({ ...ref });
  }
}

/**
 * Remove a reference from a repo entry by repo ID.
 * Mutates entry in place — call saveIndex after.
 * Returns true if removed, false if not found.
 */
export function removeReference(entry: RepoEntry, repoId: string): boolean {
  if (!entry.references) return false;
  const before = entry.references.length;
  entry.references = entry.references.filter(r => r.repo !== repoId);
  if (entry.references.length === 0) delete entry.references;
  return entry.references ? entry.references.length < before : before > 0;
}
