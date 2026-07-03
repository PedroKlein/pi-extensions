/**
 * pi-repos — Code search via ripgrep.
 *
 * Scope:
 * - repo  → primary worktree (cloned) or repo path (local)
 * - group → all member repos
 * - all   → every managed repo
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReposConfig, SearchMatch, SearchOutput } from "./types.js";
import { getPaths } from "./config.js";
import { loadIndex, resolveRepo, repoId } from "./storage.js";

const execFile = promisify(execFileCb);

// ─── rg JSON types ────────────────────────────────────────────────────────────

interface RgMatchData {
  path:        { text: string };
  line_number: number;
  lines:       { text: string };
  submatches:  Array<{ match: { text: string }; start: number; end: number }>;
}

interface RgContextData {
  path:        { text: string };
  line_number: number;
  lines:       { text: string };
}

interface RgLine {
  type: "match" | "context" | "begin" | "end" | "summary";
  data: RgMatchData | RgContextData | Record<string, unknown>;
}

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the list of { path, repoLabel } pairs to search given scope options.
 * - repo  → single primary worktree
 * - group → all member repo worktrees
 * - all   → every repo's primary worktree
 */
function resolveSearchTargets(
  config: ReposConfig,
  options: { repo?: string; group?: string },
): Array<{ path: string; label: string }> {
  const index = loadIndex(config);
  const paths = getPaths(config);

  if (options.repo) {
    const entry      = resolveRepo(index, options.repo); // throws if not found
    const searchPath = primarySearchPath(entry);
    return searchPath ? [{ path: searchPath, label: repoId(entry) }] : [];
  }

  if (options.group) {
    const groupJson = join(paths.groups, options.group, "group.json");
    if (!existsSync(groupJson)) {
      throw new Error(`Group not found: ${options.group}`);
    }
    const group    = JSON.parse(readFileSync(groupJson, "utf-8"));
    const members: string[] = group.repos ?? [];
    const results: Array<{ path: string; label: string }> = [];
    for (const member of members) {
      try {
        const entry      = resolveRepo(index, member);
        const searchPath = primarySearchPath(entry);
        if (searchPath) results.push({ path: searchPath, label: repoId(entry) });
      } catch { /* skip unresolvable members */ }
    }
    return results;
  }

  // All repos
  return index.repos.flatMap(entry => {
    const searchPath = primarySearchPath(entry);
    return searchPath ? [{ path: searchPath, label: repoId(entry) }] : [];
  });
}

/** Return the primary directory to search for a repo entry. */
function primarySearchPath(entry: import("./types.js").RepoEntry): string | null {
  if (entry.type === "local") {
    return existsSync(entry.path) ? entry.path : null;
  }
  // cloned: use first worktree
  for (const wt of entry.worktrees) {
    if (existsSync(wt.path)) return wt.path;
  }
  return null;
}

// ─── Ripgrep Search ───────────────────────────────────────────────────────────

/**
 * Run rg --json in a single directory and return parsed matches.
 */
async function rgSearch(
  dir: string,
  repoLabel: string,
  pattern: string,
  options: {
    glob?:          string;
    caseSensitive?: boolean;
    limit?:         number;
  },
  collectedSoFar: number,
): Promise<SearchMatch[]> {
  const limit    = options.limit ?? 50;
  const headroom = limit - collectedSoFar;
  if (headroom <= 0) return [];

  const args: string[] = ["--json"];
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.glob)           args.push("--glob", options.glob);
  args.push("--max-count",   String(headroom));
  args.push("--context",     "2");
  args.push(pattern, dir);

  let stdout = "";
  try {
    ({ stdout } = await execFile("rg", args, { maxBuffer: 10 * 1024 * 1024 }));
  } catch (err: any) {
    // rg exits 1 when no matches (not an error), 2+ on real errors
    if (err.code === 1) return [];
    if (err.code === "ENOENT" || (err.message && err.message.includes("ENOENT"))) {
      throw new Error(
        "ripgrep (rg) not found on PATH. Install it with: brew install ripgrep / apt install ripgrep"
      );
    }
    // maxBuffer exceeded — parse partial stdout that was captured
    if (err.message && err.message.includes("maxBuffer") && err.stdout) {
      stdout = err.stdout;
    } else if (err.stderr && err.stderr.length > 0) {
      throw new Error(`rg error: ${err.stderr.trim()}`);
    } else {
      // exit 2 = usage error, else propagate
      throw err;
    }
  }

  const matches: SearchMatch[]  = [];
  const contextMap              = new Map<string, string[]>(); // key → context lines
  let   pendingContextKey: string | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let parsed: RgLine;
    try { parsed = JSON.parse(line); } catch { continue; }

    if (parsed.type === "match") {
      const d          = parsed.data as RgMatchData;
      const file       = d.path.text;
      const lineNum    = d.line_number;
      const content    = d.lines.text.trimEnd();

      const match: SearchMatch = {
        repo:    repoLabel,
        file:    file.startsWith(dir) ? file.slice(dir.length).replace(/^\//, "") : file,
        line:    lineNum,
        content,
      };
      matches.push(match);
      pendingContextKey = `${file}:${lineNum}`;
      contextMap.set(pendingContextKey, []);
    } else if (parsed.type === "context" && pendingContextKey) {
      const d    = parsed.data as RgContextData;
      const ctx  = contextMap.get(pendingContextKey);
      if (ctx) ctx.push(d.lines.text.trimEnd());
    }
  }

  // Attach context arrays to matches
  for (const m of matches) {
    const key = `${m.file}:${m.line}`;
    const ctx = contextMap.get(key);
    if (ctx && ctx.length > 0) m.context = ctx;
  }

  return matches;
}

// ─── Main Search Entry Point ──────────────────────────────────────────────────

export interface SearchOptions {
  repo?:          string;
  group?:         string;
  glob?:          string;
  caseSensitive?: boolean;
  limit?:         number;
}

/**
 * Search across managed repos using ripgrep.
 */
export async function searchRepos(
  config:  ReposConfig,
  pattern: string,
  options: SearchOptions = {},
): Promise<SearchOutput> {
  const limit   = options.limit ?? 50;
  const targets = resolveSearchTargets(config, { repo: options.repo, group: options.group });

  const allMatches: SearchMatch[] = [];

  for (const { path, label } of targets) {
    if (allMatches.length >= limit) break;
    const found = await rgSearch(path, label, pattern, {
      glob:          options.glob,
      caseSensitive: options.caseSensitive,
      limit,
    }, allMatches.length);
    allMatches.push(...found);
  }

  return {
    matches: allMatches.slice(0, limit),
    total:   allMatches.length,
  };
}
