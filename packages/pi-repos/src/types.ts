/**
 * pi-repos — All type definitions.
 */

// ─── Core Entities ──────────────────────────────────────────────────────────

export type RepoType = "cloned" | "local";

export type ConnectionRelationship =
  | "deploys-to"
  | "depends-on"
  | "configures"
  | "shared-lib"
  | "imports"
  | "consumes"
  | (string & {});

export type AnnotationCategory =
  | "architecture"
  | "pattern"
  | "bug"
  | "decision"
  | "cross-cutting";

export type GroupAction =
  | "create"
  | "add"
  | "remove"
  | "info"
  | "docs"
  | "connect"
  | "sync"
  | "suggest";

// ─── Domain Models ──────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

export interface Reference {
  /** Repo ID (must exist in pi-repos index) */
  repo: string;
  /** Pinned version — tag or SHA (optional) */
  tag?: string;
  /** Why this is referenced (e.g. "CRD API shapes", "shared event schema") */
  reason?: string;
}

export interface RepoEntry {
  host: string;
  owner: string;
  name: string;
  type: RepoType;
  /** Original clone URL (null for local repos without a remote) */
  url: string | null;
  /** Absolute path: .bare/ dir for cloned, actual repo root for local */
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
  tags: string[];
  autoTags: string[];
  starred: boolean;
  lastAccessed: string;
  addedAt: string;
  lastSyncedAt: string | null;
  commitsBehind: number | null;
  /** Pinned ref if cloned at a specific tag/SHA (detached worktree) */
  pinnedRef?: string;
  /** Unidirectional references to other repos for context */
  references?: Reference[];
}

export interface Connection {
  from: string;
  to: string;
  relationship: ConnectionRelationship;
  description?: string;
}

export interface RepoGroup {
  name: string;
  description: string;
  repos: string[];
  connections: Connection[];
  /** Unidirectional references to repos for group-level context */
  references?: Reference[];
  created: string;
  updated: string;
}

export interface Annotation {
  category: AnnotationCategory;
  content: string;
  timestamp: string;
  files?: string[];
}

export interface Summary {
  tldr: string;
  full?: string;
  rev: string;
  stale: boolean;
}

export interface FreshnessInfo {
  lastSync: string | null;
  commitsBehind: number | null;
  indexStale: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

// ─── Hooks ──────────────────────────────────────────────────────────────────

export type HookEvent = "post-add" | "post-sync" | "pre-remove";

export interface HookEntry {
  command: string;
  args: string[];
  timeout?: number; // ms, default 180_000
}

export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ReposConfig {
  storageDir: string;
  summaryModel?: string;
  hooks?: HooksConfig;
}

export const DEFAULT_CONFIG: ReposConfig = {
  storageDir: "~/.local/share/pi-repos",
};

// ─── Tool I/O Shapes ────────────────────────────────────────────────────────

export interface AddInput {
  url?: string;
  local?: string;
  tags?: string[];
  group?: string;
  starred?: boolean;
  /** Clone at a specific tag or ref (creates detached worktree) */
  tag?: string;
}

export interface AddOutput {
  repo: string;
  type: RepoType;
  path: string;
  tags: string[];
  autoTags: string[];
  message: string;
  pinnedRef?: string;
}

export interface InfoInput {
  repo: string;
  regenerate?: boolean;
}

export interface InfoOutput {
  entry: RepoEntry;
  summary: Summary | null;
  annotations: Annotation[];
  freshness: FreshnessInfo;
}

export interface ListInput {
  group?: string;
  tag?: string;
  starred?: boolean;
  query?: string;
  verbose?: boolean;
}

export interface ListOutputCompact {
  repos: Array<{
    id: string;
    path: string;
  }>;
  total: number;
}

export interface ListOutputVerbose {
  repos: Array<{
    id: string;
    type: RepoType;
    path: string;
    tags: string[];
    starred: boolean;
    freshness: FreshnessInfo;
    tldr?: string;
  }>;
  total: number;
}

export type ListOutput = ListOutputCompact | ListOutputVerbose;

export interface RemoveInput {
  repo: string;
}

export interface RemoveOutput {
  removed: string;
  type: RepoType;
  storageDeleted: boolean;
  message: string;
}

export interface SearchInput {
  pattern: string;
  repo?: string;
  group?: string;
  glob?: string;
  caseSensitive?: boolean;
  limit?: number;
}

export interface SearchMatch {
  repo: string;
  file: string;
  line: number;
  content: string;
  context?: string[];
}

export interface SearchOutput {
  matches: SearchMatch[];
  total: number;
}

export interface AnnotateInput {
  repo?: string;
  group?: string;
  category: AnnotationCategory;
  content: string;
  files?: string[];
}

export interface AnnotateOutput {
  target: string;
  category: AnnotationCategory;
  message: string;
}

export interface GroupInput {
  action: GroupAction;
  name: string;
  repo?: string;
  description?: string;
  repos?: string[];
  from?: string;
  to?: string;
  relationship?: ConnectionRelationship;
  docAction?: "list" | "read" | "write";
  docPath?: string;
  docContent?: string;
  /** For suggest action: whether to also generate group docs after confirming */
  regenerateDocs?: boolean;
}

export interface ConnectionSuggestion {
  from: string;
  to: string;
  relationship: ConnectionRelationship;
  description: string;
  confidence: "high" | "medium" | "low";
}

export interface GroupOutput {
  action: GroupAction;
  group: RepoGroup | null;
  message: string;
  docContent?: string;
  docs?: string[];
}

export interface SyncInput {
  repo?: string;
  group?: string;
  all?: boolean;
}

export interface SyncOutput {
  synced: Array<{
    repo: string;
    fetched: boolean;
    error?: string;
  }>;
  total: number;
  message: string;
}
