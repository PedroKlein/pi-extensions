/**
 * Plan file persistence.
 *
 * Storage layout (centralized under ~/.pi/plans/<repo-slug>/):
 *   ~/.pi/plans/
 *     <org>-<repo>/              → identified from git remote origin (org/repo slug)
 *       active.json              → { planName: "improve-plan-mode", updatedAt: 1234 }
 *       plans/
 *         improve-plan-mode/
 *           plan.json            → PlanGraph
 *         fix-auth-bug/
 *           plan.json            → PlanGraph
 *     global/                    → for non-git directories
 *       ...
 *
 * Repo identification:
 *   1. git remote get-url origin → extract org/repo → slugify "org-repo"
 *   2. Fallback (no remote): git root directory basename
 *   3. Fallback (no git): "global"
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PlanGraph, ActivePlanRef } from "./plan.js";

// ─── Centralized Storage Path ──────────────────────────────────────────

const PI_PLANS_ROOT = join(homedir(), ".pi", "plans");

let cachedRepoSlug: string | null = null;
let cachedWorktreeSlug: string | null = null;

function getPlanDir(): string {
	if (!cachedRepoSlug) throw new Error("Plan storage not initialized. Call initPlanStorage() first.");
	return join(PI_PLANS_ROOT, cachedRepoSlug);
}

function getPlansDir(): string {
	return join(getPlanDir(), "plans");
}

function getActiveFile(): string {
	if (!cachedWorktreeSlug) return join(getPlanDir(), "active.json");
	return join(getPlanDir(), `active-${cachedWorktreeSlug}.json`);
}

/**
 * Legacy active file path (pre-worktree support).
 * Used as fallback for migration.
 */
function getLegacyActiveFile(): string {
	return join(getPlanDir(), "active.json");
}

function planFilePath(planName: string): string {
	return join(getPlansDir(), planName, "plan.json");
}

/**
 * Extract org/repo slug from a git remote URL.
 * Handles SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
 * Returns "org-repo" or null if parsing fails.
 */
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
	// "org/repo" → "org-repo"
	return remotePath
		.replace(/\//g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "")
		.toLowerCase() || null;
}

/**
 * Initialize plan storage by resolving the repo slug.
 * Must be called once at session start before any plan operations.
 */
export async function initPlanStorage(pi: ExtensionAPI): Promise<string> {
	// 1. Try git remote origin
	try {
		const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], { timeout: 2000 });
		if (remoteResult.code === 0 && remoteResult.stdout.trim()) {
			const slug = parseRemoteToSlug(remoteResult.stdout);
			if (slug) {
				cachedRepoSlug = slug;
			}
		}
	} catch {
		// Not a git repo or no remote
	}

	// 2. Fallback: git root basename
	if (!cachedRepoSlug) {
		try {
			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 });
			if (rootResult.code === 0 && rootResult.stdout.trim()) {
				cachedRepoSlug = basename(rootResult.stdout.trim()).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "unnamed";
			}
		} catch {
			// Not a git repo
		}
	}

	// 3. Fallback: global
	if (!cachedRepoSlug) {
		cachedRepoSlug = "global";
	}

	// 4. Resolve worktree slug for per-worktree active ref
	try {
		const toplevelResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 });
		if (toplevelResult.code === 0 && toplevelResult.stdout.trim()) {
			const toplevel = toplevelResult.stdout.trim();
			cachedWorktreeSlug = basename(toplevel).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 60) || null;
		}
	} catch {
		// Not a git repo — no worktree discrimination needed
	}

	return cachedRepoSlug;
}

/**
 * Get the current repo slug (for display/debugging).
 */
export function getRepoSlug(): string | null {
	return cachedRepoSlug;
}

/**
 * List all repo slugs that have plans stored.
 */
export function listRepoSlugs(): string[] {
	return fsListDir(PI_PLANS_ROOT);
}

// ─── Low-level I/O via Node fs ─────────────────────────────────────────

function fsRead(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function fsWrite(filePath: string, content: string): boolean {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content, "utf-8");
		return true;
	} catch {
		return false;
	}
}

function fsExists(filePath: string): boolean {
	try {
		return existsSync(filePath);
	} catch {
		return false;
	}
}

function fsListDir(dirPath: string): string[] {
	try {
		if (!existsSync(dirPath)) return [];
		return readdirSync(dirPath).filter(Boolean);
	} catch {
		return [];
	}
}

function fsRemove(filePath: string): boolean {
	try {
		if (existsSync(filePath)) unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function fsDirExists(dirPath: string): boolean {
	try {
		return existsSync(dirPath) && statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

// ─── Parse Helpers ─────────────────────────────────────────────────────

function parseJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

// ─── Public API ────────────────────────────────────────────────────────
// All public functions return safe defaults (null/empty/false) when
// plan storage hasn't been initialized yet, rather than throwing.

/**
 * Load the active plan reference.
 * Falls back to legacy active.json if no worktree-specific ref exists (migration).
 */
export async function loadActiveRef(_pi: ExtensionAPI): Promise<ActivePlanRef | null> {
	if (!cachedRepoSlug) return null;
	const raw = fsRead(getActiveFile());
	if (raw) return parseJson<ActivePlanRef>(raw);
	// Fallback: legacy active.json (pre-worktree support)
	if (cachedWorktreeSlug) {
		const legacyRaw = fsRead(getLegacyActiveFile());
		if (legacyRaw) return parseJson<ActivePlanRef>(legacyRaw);
	}
	return null;
}

/**
 * Save the active plan reference.
 */
export async function saveActiveRef(_pi: ExtensionAPI, ref: ActivePlanRef): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	return fsWrite(getActiveFile(), JSON.stringify(ref, null, 2));
}

/**
 * Clear the active plan reference (no active plan).
 */
export async function clearActiveRef(_pi: ExtensionAPI): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	return fsRemove(getActiveFile());
}

/**
 * Load a plan by name.
 */
export async function loadPlan(_pi: ExtensionAPI, planName: string): Promise<PlanGraph | null> {
	if (!cachedRepoSlug) return null;
	const raw = fsRead(planFilePath(planName));
	if (!raw) return null;
	return parseJson<PlanGraph>(raw);
}

/**
 * Save a plan. Also updates the active ref if the plan is active.
 */
export async function savePlan(_pi: ExtensionAPI, graph: PlanGraph): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	const name = slugifyPlanName(graph.name);
	const ok = fsWrite(planFilePath(name), JSON.stringify(graph, null, 2));
	if (!ok) return false;

	if (graph.status === "active") {
		fsWrite(getActiveFile(), JSON.stringify({ planName: name, updatedAt: graph.updatedAt } satisfies ActivePlanRef, null, 2));
	}

	return true;
}

/**
 * Load the currently active plan.
 */
export async function loadActivePlan(pi: ExtensionAPI): Promise<PlanGraph | null> {
	if (!cachedRepoSlug) return null;
	const ref = await loadActiveRef(pi);
	if (!ref) return null;
	return loadPlan(pi, ref.planName);
}

/**
 * Synchronous version: load the currently active plan without async.
 * Returns null if plan storage hasn't been initialized yet.
 */
export function loadActivePlanSync(): PlanGraph | null {
	if (!cachedRepoSlug) return null;
	let raw = fsRead(getActiveFile());
	// Fallback: legacy active.json (pre-worktree support)
	if (!raw && cachedWorktreeSlug) {
		raw = fsRead(getLegacyActiveFile());
	}
	if (!raw) return null;
	const ref = parseJson<ActivePlanRef>(raw);
	if (!ref) return null;
	const planRaw = fsRead(planFilePath(ref.planName));
	if (!planRaw) return null;
	return parseJson<PlanGraph>(planRaw);
}

/**
 * List all plan names.
 */
export async function listPlanNames(_pi: ExtensionAPI): Promise<string[]> {
	if (!cachedRepoSlug) return [];
	return fsListDir(getPlansDir());
}

/**
 * Summary info for a plan (loaded without full graph).
 */
export interface PlanSummary {
	name: string;
	status: string;
	totalTasks: number;
	doneTasks: number;
	isActive: boolean;
}

/**
 * Load summaries for all plans. Synchronous since all I/O is Node fs.
 * Returns empty array if plan storage hasn't been initialized yet.
 */
export function loadPlanSummaries(): PlanSummary[] {
	if (!cachedRepoSlug) return [];
	const names = fsListDir(getPlansDir());
	let activeRaw = fsRead(getActiveFile());
	// Fallback: legacy active.json
	if (!activeRaw && cachedWorktreeSlug) {
		activeRaw = fsRead(getLegacyActiveFile());
	}
	const activeName = activeRaw ? parseJson<ActivePlanRef>(activeRaw)?.planName : null;

	return names.map((name) => {
		const raw = fsRead(planFilePath(name));
		if (!raw) return { name, status: "unknown", totalTasks: 0, doneTasks: 0, isActive: name === activeName };
		const graph = parseJson<PlanGraph>(raw);
		if (!graph) return { name, status: "unknown", totalTasks: 0, doneTasks: 0, isActive: name === activeName };
		return {
			name,
			status: graph.status,
			totalTasks: graph.tasks.length,
			doneTasks: graph.tasks.filter((t) => t.status === "done").length,
			isActive: name === activeName,
		};
	});
}

/**
 * Archive a plan (set status to "archived", clear active ref if it was active).
 */
export async function archivePlan(pi: ExtensionAPI, planName: string): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	const slug = slugifyPlanName(planName);
	const graph = await loadPlan(pi, slug);
	if (!graph) return false;

	graph.status = "archived";
	graph.updatedAt = Date.now();
	const ok = await savePlan(pi, graph);
	if (!ok) return false;

	const ref = await loadActiveRef(pi);
	if (ref?.planName === slug) {
		await clearActiveRef(pi);
	}

	return true;
}

/**
 * Unarchive a plan (set status back to "active").
 * Does NOT make it the current active plan — that requires saveActiveRef separately.
 */
export async function unarchivePlan(pi: ExtensionAPI, planName: string): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	const slug = slugifyPlanName(planName);
	const graph = await loadPlan(pi, slug);
	if (!graph) return false;
	if (graph.status !== "archived") return true; // already not archived

	graph.status = "active";
	graph.updatedAt = Date.now();
	return savePlan(pi, graph);
}

/**
 * Check if .plan directory exists.
 */
export async function planDirExists(_pi: ExtensionAPI): Promise<boolean> {
	if (!cachedRepoSlug) return false;
	return fsDirExists(getPlanDir());
}

// ─── Helpers ───────────────────────────────────────────────────────────

function slugifyPlanName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-_]/g, "")
		.slice(0, 60) || "plan";
}
