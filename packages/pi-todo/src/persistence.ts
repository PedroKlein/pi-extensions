/**
 * Split-file persistence for todo state.
 *
 * Storage layout (centralized under ~/.pi/todo/):
 *   ~/.pi/todo/
 *     <org-repo>.json           → Task[] (feature, bug, chore, research)
 *     global.json               → Task[] (personal tasks)
 *     reviews.json              → Task[] (review tasks, work-related)
 *
 * IDs are per-scope (each scope has its own numbering, derived from max(id)+1).
 *
 * Repo identification:
 *   1. git remote get-url origin → extract org/repo → slugify "org-repo"
 *   2. Fallback (no remote): git root directory basename
 *   3. Fallback (no git): "global"
 *
 * Migration: on first load, reads old ~/.pi/agent/todo/pi-todo.json
 *   and splits tasks into the new structure.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task, TodoState } from "./model.js";
import { GLOBAL_REPO_ID, REVIEW_REPO_ID } from "./model.js";

// ─── Centralized Storage Path ──────────────────────────────────────────

const TODO_ROOT = join(homedir(), ".config", "todo");
const OLD_DATA_FILE = join(homedir(), ".pi", "agent", "todo", "pi-todo.json");

/** Legacy split-file location (pre-migration). */
const LEGACY_TODO_ROOT = join(homedir(), ".pi", "todo");

/** Marker file to indicate migration has been done. */
const MIGRATED_MARKER = join(TODO_ROOT, ".migrated");

/** Marker for legacy split-file migration. */
const LEGACY_MIGRATED_MARKER = join(TODO_ROOT, ".legacy-migrated");

let cachedRepoSlug: string | null = null;

// ─── Repo Slug Resolution ──────────────────────────────────────────────

function parseRemoteToSlug(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim();
	// SSH: git@github.com:org/repo.git
	const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
	if (sshMatch) {
		return slugifyRemotePath(sshMatch[1]);
	}
	// HTTPS: https://github.com/org/repo.git
	try {
		const url = new URL(trimmed);
		const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
		if (path) return slugifyRemotePath(path);
	} catch {
		// Not a valid URL
	}
	return null;
}

function slugifyRemotePath(remotePath: string): string | null {
	// Split owner/repo and join with __ separator
	// e.g., "PedroKlein/dotfiles" → "pedroklein__dotfiles"
	// This keeps repo names with dashes intact (e.g., "strat/kms-lite" → "strat__kms-lite")
	const parts = remotePath.split("/");
	if (parts.length < 2) return null;
	const owner = parts[0].toLowerCase().replace(/[^a-z0-9._-]/g, "");
	const repo = parts[1].toLowerCase().replace(/[^a-z0-9._-]/g, "");
	if (!owner || !repo) return null;
	return `${owner}__${repo}`;
}

/**
 * Initialize todo storage by resolving the repo slug.
 * Must be called once at session start before any todo operations.
 * Also runs migration from old format if needed.
 */
export async function initTodoStorage(pi: ExtensionAPI): Promise<string> {
	// 1. Try git remote origin
	try {
		const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], { timeout: 2000 });
		if (remoteResult.code === 0 && remoteResult.stdout.trim()) {
			const slug = parseRemoteToSlug(remoteResult.stdout);
			if (slug) {
				cachedRepoSlug = slug;
				maybeMigrate();
				return slug;
			}
		}
	} catch {
		// Not a git repo or no remote
	}

	// 2. Fallback: git root basename
	try {
		const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 });
		if (rootResult.code === 0 && rootResult.stdout.trim()) {
			cachedRepoSlug = basename(rootResult.stdout.trim()).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "unnamed";
			maybeMigrate();
			return cachedRepoSlug;
		}
	} catch {
		// Not a git repo
	}

	// 3. Fallback: global
	cachedRepoSlug = GLOBAL_REPO_ID;
	maybeMigrate();
	return cachedRepoSlug;
}

/**
 * Get the current repo slug.
 */
export function getRepoSlug(): string {
	if (!cachedRepoSlug) throw new Error("Todo storage not initialized. Call initTodoStorage() first.");
	return cachedRepoSlug;
}

// ─── Low-level I/O ─────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
	try {
		const data = readFileSync(filePath, "utf-8");
		return JSON.parse(data) as T;
	} catch {
		return null;
	}
}

function writeJson(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function listScopes(): string[] {
	try {
		if (!existsSync(TODO_ROOT)) return [];
		return readdirSync(TODO_ROOT)
			.filter((f) => f.endsWith(".json") && f !== ".migrated")
			.map((f) => f.replace(/\.json$/, ""));
	} catch {
		return [];
	}
}

function scopeTasksFile(scope: string): string {
	return join(TODO_ROOT, `${scope}.json`);
}

function loadScopeTasks(scope: string): Task[] {
	const tasks = readJson<Task[]>(scopeTasksFile(scope));
	return Array.isArray(tasks) ? tasks : [];
}

function saveScopeTasks(scope: string, tasks: Task[]): void {
	writeJson(scopeTasksFile(scope), tasks);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Load all tasks from all scopes.
 */
export async function loadState(): Promise<TodoState> {
	const scopes = listScopes();
	const allTasks: Task[] = [];
	for (const scope of scopes) {
		allTasks.push(...loadScopeTasks(scope));
	}
	return { tasks: allTasks };
}

/**
 * Save state — split tasks by repoId into scope directories.
 * Writes empty arrays for scopes that lost all tasks (prevents resurrection on reload).
 */
export async function saveState(state: TodoState): Promise<void> {
	const groups = new Map<string, Task[]>();

	// Initialize with all known scopes (to clear deleted ones)
	for (const scope of listScopes()) {
		groups.set(scope, []);
	}

	// Group tasks by repoId
	for (const task of state.tasks) {
		const scope = task.repoId;
		if (!groups.has(scope)) groups.set(scope, []);
		groups.get(scope)!.push(task);
	}

	// Write each scope
	for (const [scope, tasks] of groups) {
		saveScopeTasks(scope, tasks);
	}
}

// ─── Migration from old format ─────────────────────────────────────────

/**
 * Migrate from the old single-file format (~/.pi/agent/todo/pi-todo.json)
 * to the new split-file structure under ~/.pi/todo/.
 *
 * Only runs if the old file exists and migration hasn't been done yet.
 */
function maybeMigrate(): void {
	// Skip if already migrated
	if (existsSync(MIGRATED_MARKER)) return;

	// Skip if old file doesn't exist
	if (!existsSync(OLD_DATA_FILE)) {
		// Mark as migrated so we don't check again
		writeJson(MIGRATED_MARKER, { migratedAt: Date.now(), note: "no old data found" });
		return;
	}

	const oldState = readJson<{ tasks: Task[]; nextId: number }>(OLD_DATA_FILE);
	if (!oldState || !Array.isArray(oldState.tasks)) {
		writeJson(MIGRATED_MARKER, { migratedAt: Date.now(), note: "old data unreadable" });
		return;
	}

	// Group tasks by migrated repoId
	const groups = new Map<string, Task[]>();

	for (const task of oldState.tasks) {
		const newRepoId = migrateRepoId(task.repoId, task.type);
		task.repoId = newRepoId;

		if (!groups.has(newRepoId)) groups.set(newRepoId, []);
		groups.get(newRepoId)!.push(task);
	}

	// Re-number IDs per scope (1-based)
	for (const [, tasks] of groups) {
		for (let i = 0; i < tasks.length; i++) {
			tasks[i].id = i + 1;
		}
	}

	// Write each scope
	for (const [scope, tasks] of groups) {
		saveScopeTasks(scope, tasks);
	}

	// Mark as migrated
	writeJson(MIGRATED_MARKER, { migratedAt: Date.now(), taskCount: oldState.tasks.length });

	// Rename old file as backup
	try {
		renameSync(OLD_DATA_FILE, OLD_DATA_FILE + ".bak");
	} catch {
		// Ignore — migration marker prevents re-running
	}
}

/**
 * Convert old repoId formats to new slug format.
 * - "global/personal" → GLOBAL_REPO_ID or REVIEW_REPO_ID based on type
 * - Raw git URL → org-repo slug
 * - Absolute path → basename slug
 */
function migrateRepoId(oldRepoId: string, taskType: string): string {
	// Old global format
	if (oldRepoId === "global/personal") {
		if (taskType === "review") return REVIEW_REPO_ID;
		return GLOBAL_REPO_ID;
	}

	// Git URL → slug
	const slug = parseRemoteToSlug(oldRepoId);
	if (slug) return slug;

	// Absolute path → basename
	if (oldRepoId.startsWith("/")) {
		return basename(oldRepoId).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "unnamed";
	}

	// Already looks like a slug or unknown → use as-is
	return oldRepoId;
}
