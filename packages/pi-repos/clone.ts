/**
 * pi-repos — Clone, register, remove, sync, and list repos.
 *
 * Handles:
 * - Bare-clone repos + worktree creation
 * - Local repo registration (index-only)
 * - repos_remove with type-safety (never deletes a local repo's directory)
 * - git fetch on sync
 * - repos_list with freshness from cached meta files
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, basename } from "node:path";
import type { RepoEntry, RepoType, ReposConfig, FreshnessInfo, WorktreeInfo } from "./types.js";
import { getPaths, expandTilde } from "./config.js";
import { loadIndex, saveIndex, resolveRepo, repoId, repoMetaDir, readSummary } from "./storage.js";
import { generateTldr } from "./summarize.js";
import { executeHooks, type HookVariables } from "./hooks.js";

const execFile = promisify(execFileCb);

// ─── URL Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a git remote URL into its components.
 * Supports:
 *   - https://host/owner/repo[.git]
 *   - git@host:owner/repo[.git]
 *   - ssh://[user@]host[:port]/owner/repo[.git]
 */
export function parseGitUrl(url: string): { host: string; owner: string; name: string } {
  // https://github.com/owner/repo.git (with optional port)
  const httpsMatch = url.match(/^https?:\/\/([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    const [, host, owner, name] = httpsMatch;
    return { host, owner, name };
  }

  // git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    const [, host, owner, name] = sshMatch;
    return { host, owner, name };
  }

  // ssh://git@host[:port]/owner/repo.git
  const sshProtoMatch = url.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshProtoMatch) {
    const [, host, owner, name] = sshProtoMatch;
    return { host, owner, name };
  }

  throw new Error(`Cannot parse git URL: "${url}". Expected https://host/owner/repo, git@host:owner/repo, or ssh://host/owner/repo`);
}

// ─── Worktree Helpers ────────────────────────────────────────────────────────

/**
 * Parse `git worktree list --porcelain` output into WorktreeInfo[].
 * Skips the bare repo dir itself.
 */
async function parseWorktrees(gitDir: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFile("git", ["-C", gitDir, "worktree", "list", "--porcelain"]);
  const results: WorktreeInfo[] = [];

  for (const block of stdout.trim().split(/\n\n+/)) {
    const lines = block.split("\n");
    const pathLine   = lines.find(l => l.startsWith("worktree "));
    const headLine   = lines.find(l => l.startsWith("HEAD "));
    const branchLine = lines.find(l => l.startsWith("branch "));

    if (!pathLine) continue;

    const path   = pathLine.slice("worktree ".length).trim();
    const commit = headLine   ? headLine.slice("HEAD ".length).trim()     : "";
    const branch = branchLine
      ? branchLine.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
      : "HEAD";

    // Skip the bare repo itself — it is not a checkout worktree
    if (path.endsWith("/.bare") || path.endsWith("\\.bare")) continue;

    results.push({ path, branch, commit });
  }

  return results;
}

// ─── Auto-tagging ─────────────────────────────────────────────────────────────

/** Derive language/purpose tags from directory contents (no LLM, no cost). */
async function detectAutoTags(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const tags: string[] = [];

  const checks: Array<[string[], string]> = [
    [["go.mod"],                                        "go"          ],
    [["package.json"],                                  "nodejs"      ],
    [["Cargo.toml"],                                    "rust"        ],
    [["pyproject.toml", "setup.py", "requirements.txt"], "python"    ],
    [["pom.xml", "build.gradle"],                       "java"       ],
    [["Dockerfile", "docker-compose.yml"],              "containerized"],
    [["k8s", "kubernetes"],                             "kubernetes"  ],
    [[".github/workflows"],                             "ci-github"   ],
  ];

  for (const [files, tag] of checks) {
    if (files.some(f => existsSync(join(dir, f)))) tags.push(tag);
  }

  return tags;
}

// ─── Freshness Helpers ────────────────────────────────────────────────────────

/** Derive FreshnessInfo from a repo entry (no filesystem I/O). */
function deriveFreshness(config: ReposConfig, entry: RepoEntry): FreshnessInfo {
  const metaDir = repoMetaDir(config, entry);
  const revPath = join(metaDir, "rev.txt");
  const indexStale = !existsSync(revPath);

  return {
    lastSync: entry.lastSyncedAt,
    commitsBehind: entry.commitsBehind,
    indexStale,
  };
}

// ─── Clone ───────────────────────────────────────────────────────────────────

/**
 * Clone a remote repo as a bare clone + worktree.
 * Re-add (URL already exists in index) → git fetch instead.
 * If `pinnedRef` is provided, creates a detached worktree at that tag/ref.
 */
export async function cloneRepo(
  config: ReposConfig,
  url: string,
  tags: string[] = [],
  starred = false,
  pinnedRef?: string,
): Promise<RepoEntry> {
  const { host, owner, name } = parseGitUrl(url);
  const paths        = getPaths(config);
  const repoStoreDir = join(paths.repos, host, owner, name);
  const bareDir      = join(repoStoreDir, ".bare");
  const now          = new Date().toISOString();

  mkdirSync(repoStoreDir, { recursive: true });

  // Clone or fetch
  if (!existsSync(bareDir)) {
    await execFile("git", ["clone", "--bare", url, bareDir]);
  } else {
    await execFile("git", ["-C", bareDir, "fetch", "--all", "--prune"]);
  }

  // Detect default branch
  let defaultBranch = "main";
  try {
    const { stdout } = await execFile("git", ["-C", bareDir, "symbolic-ref", "--short", "HEAD"]);
    defaultBranch = stdout.trim();
  } catch {
    try {
      const { stdout } = await execFile("git", ["-C", bareDir, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
      defaultBranch = stdout.trim().replace(/^origin\//, "");
    } catch { /* keep "main" */ }
  }

  // Create worktree: pinned (detached at ref) or default branch
  const worktreeDir = join(repoStoreDir, pinnedRef ?? defaultBranch);
  if (!existsSync(worktreeDir)) {
    if (pinnedRef) {
      // Fetch the tag/ref explicitly, then create detached worktree
      try {
        await execFile("git", ["-C", bareDir, "fetch", "origin", `+refs/tags/${pinnedRef}:refs/tags/${pinnedRef}`]).catch(() => {});
        await execFile("git", ["-C", bareDir, "worktree", "add", "--detach", worktreeDir, pinnedRef]);
      } catch {
        // ref might be a SHA or branch, not a tag — try directly
        try {
          await execFile("git", ["-C", bareDir, "worktree", "add", "--detach", worktreeDir, pinnedRef]);
        } catch { /* worktree creation failed; continue */ }
      }
    } else {
      try {
        await execFile("git", ["-C", bareDir, "worktree", "add", worktreeDir, defaultBranch]);
      } catch {
        // branch name mismatch — fall back to HEAD
        try {
          await execFile("git", ["-C", bareDir, "worktree", "add", "--detach", worktreeDir, "HEAD"]);
        } catch { /* worktree creation failed; continue */ }
      }
    }
  }

  // Collect worktrees
  let worktrees: WorktreeInfo[] = [];
  try { worktrees = await parseWorktrees(bareDir); } catch { /* ignore */ }

  // Auto-tags
  const autoTags = await detectAutoTags(existsSync(worktreeDir) ? worktreeDir : repoStoreDir);

  const entry: RepoEntry = {
    host, owner, name,
    type: "cloned",
    url,
    path: bareDir,
    defaultBranch,
    worktrees,
    tags: [...new Set(tags)],
    autoTags,
    starred,
    lastAccessed: now,
    addedAt: now,
    lastSyncedAt: now,
    commitsBehind: null,
    ...(pinnedRef ? { pinnedRef } : {}),
  };

  const index = loadIndex(config);
  const existing = index.repos.findIndex(
    r => r.host === host && r.owner === owner && r.name === name,
  );
  if (existing >= 0) {
    index.repos[existing] = entry;
  } else {
    index.repos.push(entry);
  }
  saveIndex(config, index);

  // Fire-and-forget: generate TL;DR in the background
  const metaDir = repoMetaDir(config, entry);
  generateTldr(config, entry, metaDir).catch(() => {});

  // Fire-and-forget: execute post-add hooks
  const hookVars: HookVariables = {
    path: existsSync(worktreeDir) ? worktreeDir : repoStoreDir,
    id: repoId(entry),
    branch: defaultBranch,
    host, owner, name,
  };
  executeHooks(config, "post-add", hookVars);

  return entry;
}

// ─── Register Local ───────────────────────────────────────────────────────────

/**
 * Register an existing local repo in the index (no cloning).
 * Parses the remote origin URL for host/owner/name if available.
 */
export async function registerLocal(
  config: ReposConfig,
  localPath: string,
  tags: string[] = [],
  starred = false,
): Promise<RepoEntry> {
  const absPath = expandTilde(localPath);

  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  // Accept .git (file or dir) OR .bare/ as valid git repo indicators
  const hasGitFile = existsSync(join(absPath, ".git"));
  const hasBareDir = existsSync(join(absPath, ".bare"));
  // Also check parent for .bare/ (worktree inside a bare+worktree repo)
  const parentHasBare = existsSync(join(absPath, "..", ".bare"));

  if (!hasGitFile && !hasBareDir && !parentHasBare) {
    throw new Error(`Not a git repository (no .git or .bare found): ${absPath}`);
  }

  // Determine the effective git dir for config reading
  let effectiveGitDir = absPath;
  if (hasBareDir) {
    effectiveGitDir = join(absPath, ".bare");
  } else if (!hasGitFile && parentHasBare) {
    effectiveGitDir = join(absPath, "..", ".bare");
  }

  // Determine host/owner/name from remote origin
  let host  = "local";
  let owner = "local";
  let name  = basename(absPath);
  let remoteUrl: string | null = null;

  try {
    const { stdout } = await execFile("git", ["-C", absPath, "remote", "get-url", "origin"]);
    const remote = stdout.trim();
    if (remote) {
      remoteUrl = remote;
      try {
        ({ host, owner, name } = parseGitUrl(remote));
      } catch { /* no parseable remote — try path fallback below */ }
    }
  } catch {
    // git remote get-url failed — try reading config directly from bare dir
    try {
      const configPath = join(effectiveGitDir, "config");
      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, "utf-8");
        const urlMatch = configContent.match(/url\s*=\s*(.+)/m);
        if (urlMatch) {
          const remote = urlMatch[1].trim();
          remoteUrl = remote;
          try {
            ({ host, owner, name } = parseGitUrl(remote));
          } catch { /* not parseable */ }
        }
      }
    } catch { /* config read failed */ }
  }

  // Fallback: derive host/owner/name from canonical path structure (host/owner/repo/)
  if (host === "local" && owner === "local") {
    const parts = absPath.split("/");
    // Look for a segment containing a dot (likely a hostname like github.com)
    for (let i = 0; i < parts.length - 2; i++) {
      if (parts[i].includes(".") && parts[i + 1] && parts[i + 2]) {
        const candidateHost  = parts[i];
        const candidateOwner = parts[i + 1];
        const candidateName  = parts[i + 2];
        // Validate it looks like a host (has at least one dot)
        if (candidateHost.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i)) {
          host  = candidateHost;
          owner = candidateOwner;
          name  = candidateName;
          break;
        }
      }
    }
  }

  // Detect default branch
  let defaultBranch = "main";
  try {
    const { stdout } = await execFile("git", ["-C", absPath, "symbolic-ref", "--short", "HEAD"]);
    defaultBranch = stdout.trim();
  } catch { /* keep "main" */ }

  const now = new Date().toISOString();

  let worktrees: WorktreeInfo[] = [];
  try { worktrees = await parseWorktrees(absPath); } catch { /* ignore */ }

  const autoTags = await detectAutoTags(absPath);

  const entry: RepoEntry = {
    host, owner, name,
    type: "local",
    url: remoteUrl,
    path: absPath,
    defaultBranch,
    worktrees,
    tags: [...new Set(tags)],
    autoTags,
    starred,
    lastAccessed: now,
    addedAt: now,
    lastSyncedAt: null,
    commitsBehind: null,
  };

  const index = loadIndex(config);
  const existing = index.repos.findIndex(
    r => r.host === host && r.owner === owner && r.name === name,
  );
  if (existing >= 0) {
    index.repos[existing] = entry;
  } else {
    index.repos.push(entry);
  }
  saveIndex(config, index);

  // Fire-and-forget: generate TL;DR in the background
  const metaDir = repoMetaDir(config, entry);
  generateTldr(config, entry, metaDir).catch(() => {});

  // Fire-and-forget: execute post-add hooks
  executeHooks(config, "post-add", {
    path: absPath,
    id: repoId(entry),
    branch: defaultBranch,
    host, owner, name,
  });

  return entry;
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Remove a repo from the index.
 * - cloned: deletes the storage directory (repos/{host}/{owner}/{name}/)
 * - local:  removes only the index entry — actual directory is NEVER touched
 */
export async function removeRepo(
  config: ReposConfig,
  identifier: string,
): Promise<{ removed: string; type: RepoType; storageDeleted: boolean }> {
  const index = loadIndex(config);
  const entry = resolveRepo(index, identifier);
  const id    = repoId(entry);
  const paths = getPaths(config);

  let storageDeleted = false;

  if (entry.type === "cloned") {
    const repoStoreDir = join(paths.repos, entry.host, entry.owner, entry.name);
    if (existsSync(repoStoreDir)) {
      await rm(repoStoreDir, { recursive: true, force: true });
      storageDeleted = true;
    }
  }
  // local: never delete the directory

  // Remove metadata regardless of type
  const metaDir = repoMetaDir(config, entry);
  if (existsSync(metaDir)) {
    await rm(metaDir, { recursive: true, force: true });
  }

  index.repos = index.repos.filter(
    r => !(r.host === entry.host && r.owner === entry.owner && r.name === entry.name),
  );
  saveIndex(config, index);

  return { removed: id, type: entry.type, storageDeleted };
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Fetch updates for a single repo.
 */
export async function syncRepo(
  config: ReposConfig,
  entry: RepoEntry,
): Promise<{ fetched: boolean; error?: string }> {
  let fetched = false;

  // Git fetch
  try {
    const gitCwd = entry.type === "cloned" ? entry.path : entry.path;
    await execFile("git", ["-C", gitCwd, "fetch", "--all", "--prune"]);
    fetched = true;
  } catch (err: any) {
    return { fetched: false, error: `fetch failed: ${err.message}` };
  }

  // Compute commits-behind (best-effort)
  let commitsBehind: number | null = null;
  try {
    if (entry.type === "local") {
      const { stdout } = await execFile(
        "git", ["-C", entry.path, "rev-list", "HEAD..@{upstream}", "--count"],
      );
      const n = parseInt(stdout.trim(), 10);
      if (!isNaN(n)) commitsBehind = n;
    } else if (entry.worktrees.length > 0) {
      const wt = entry.worktrees[0];
      const { stdout } = await execFile(
        "git", ["-C", entry.path, "rev-list",
          `${wt.branch}..origin/${wt.branch}`, "--count"],
      );
      const n = parseInt(stdout.trim(), 10);
      if (!isNaN(n)) commitsBehind = n;
    }
  } catch { /* upstream may not be configured */ }

  // Update index entry
  const index = loadIndex(config);
  const idx = index.repos.findIndex(
    r => r.host === entry.host && r.owner === entry.owner && r.name === entry.name,
  );
  if (idx >= 0) {
    index.repos[idx].lastAccessed = new Date().toISOString();
    index.repos[idx].lastSyncedAt = new Date().toISOString();
    index.repos[idx].commitsBehind = commitsBehind;
  }
  saveIndex(config, index);

  // Fire-and-forget: execute post-sync hooks
  const hookPath = entry.type === "cloned"
    ? (entry.worktrees.length > 0 ? entry.worktrees[0].path : entry.path)
    : entry.path;
  executeHooks(config, "post-sync", {
    path: hookPath,
    id: repoId(entry),
    branch: entry.defaultBranch,
    host: entry.host,
    owner: entry.owner,
    name: entry.name,
  });

  return { fetched };
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * List repos with optional filtering, freshness, and TL;DR.
 * When verbose is false (default), returns only id and path.
 */
export async function listRepos(
  config: ReposConfig,
  filter?: { group?: string; tag?: string; starred?: boolean; query?: string; verbose?: boolean },
): Promise<Array<{
  id: string;
  type?: RepoType;
  path: string;
  tags?: string[];
  starred?: boolean;
  freshness?: FreshnessInfo;
  tldr?: string;
}>> {
  const index = loadIndex(config);
  let repos   = [...index.repos];

  if (filter?.starred) {
    repos = repos.filter(r => r.starred);
  }

  if (filter?.tag) {
    const t = filter.tag;
    repos = repos.filter(r => r.tags.includes(t) || r.autoTags.includes(t));
  }

  if (filter?.query) {
    const q = filter.query.toLowerCase();
    repos = repos.filter(r => repoId(r).toLowerCase().includes(q));
  }

  if (filter?.group) {
    const paths        = getPaths(config);
    const groupJson    = join(paths.groups, filter.group, "group.json");
    if (existsSync(groupJson)) {
      const group   = JSON.parse(readFileSync(groupJson, "utf-8"));
      const members = new Set<string>(group.repos ?? []);
      repos = repos.filter(r =>
        members.has(repoId(r)) || members.has(`${r.owner}/${r.name}`),
      );
    } else {
      repos = [];
    }
  }

  // Compact mode (default): just id + path
  if (!filter?.verbose) {
    return repos.map(r => {
      // For cloned repos, use the first worktree path; for local repos, use entry path
      const effectivePath = r.type === "cloned" && r.worktrees.length > 0
        ? r.worktrees[0].path
        : r.path;
      return { id: repoId(r), path: effectivePath };
    });
  }

  // Verbose mode: full details
  return repos.map(r => {
    const metaDir  = repoMetaDir(config, r);
    const summary  = readSummary(metaDir);
    const freshness = deriveFreshness(config, r);
    const effectivePath = r.type === "cloned" && r.worktrees.length > 0
      ? r.worktrees[0].path
      : r.path;
    return {
      id:       repoId(r),
      type:     r.type,
      path:     effectivePath,
      tags:     [...new Set([...r.tags, ...r.autoTags])],
      starred:  r.starred,
      freshness,
      tldr:     summary?.tldr,
    };
  });
}
