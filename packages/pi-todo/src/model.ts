/**
 * Task model and helpers.
 *
 * No lanes — the board groups tasks by type (feature, bug, chore, research, review, personal).
 * Due dates drive all urgency (color-coded). Status for filtering. Priority for sort order.
 * Personal tasks go to "global" scope, review tasks go to "reviews" scope.
 */

export const GLOBAL_REPO_ID = "global";
export const WORK_REPO_ID = "work";
export const REVIEW_REPO_ID = "reviews";

export const TASK_TYPES = ["feature", "bug", "chore", "research", "review", "personal"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Types that are always global regardless of current repo. */
export const GLOBAL_TYPES: readonly TaskType[] = ["personal", "review"];

/**
 * Get the effective repoId for a task based on its type.
 * Personal tasks → GLOBAL_REPO_ID, Review tasks → REVIEW_REPO_ID, others → currentRepoId.
 */
export function getTaskRepoId(type: TaskType, currentRepoId: string): string {
	if (type === "personal") return GLOBAL_REPO_ID;
	if (type === "review") return REVIEW_REPO_ID;
	return currentRepoId;
}

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["open", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** PR metadata fetched from GitHub API. */
export interface PrMeta {
	title: string;
	author: string;
	state: "open" | "closed" | "merged";
	branch: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
}

/** A review task action. */
export interface TaskAction {
	key: string;
	label: string;
	description?: string;
}

/** Available actions for review tasks. */
export const REVIEW_ACTIONS: TaskAction[] = [
	{ key: "s", label: "AI Summary", description: "Fetch diff and show a structured AI summary with Q&A" },
	{ key: "o", label: "Open in browser", description: "Open the PR URL in the default browser" },
	{ key: "c", label: "Clone & Review", description: "Clone repo to tmp, open a new pi session with full AI review" },
];

export interface Task {
	id: number;
	title: string;
	status: TaskStatus;
	type: TaskType;
	priority: TaskPriority;
	dueDate?: string; // ISO date string YYYY-MM-DD
	description?: string;
	url?: string;
	prMeta?: PrMeta;
	note?: string;
	repoId: string;
	createdAt: number;
	updatedAt: number;
}

export interface TodoState {
	tasks: Task[];
}

/**
 * Get the next available ID for a scope.
 * Computed from max existing ID in that scope + 1.
 */
export function getNextIdForScope(tasks: Task[], scope: string): number {
	const scopeTasks = tasks.filter((t) => t.repoId === scope);
	if (scopeTasks.length === 0) return 1;
	return Math.max(...scopeTasks.map((t) => t.id)) + 1;
}

export type StatusFilter = "active" | "open" | "blocked" | "done" | "all";

export const STATUS_FILTERS: StatusFilter[] = ["active", "open", "blocked", "done", "all"];

/**
 * Check if a type is always global.
 */
export function isGlobalType(type: TaskType): boolean {
	return (GLOBAL_TYPES as readonly string[]).includes(type);
}

/**
 * Create a new task with defaults filled in.
 * Personal tasks are always routed to the "global" scope.
 * Review tasks are always routed to the "reviews" scope.
 */
export function createTask(
	id: number,
	title: string,
	repoId: string,
	partial?: Partial<Task>
): Task {
	const now = Date.now();
	const type = partial?.type ?? "chore";
	const effectiveRepoId = getTaskRepoId(type, repoId);
	return {
		id,
		title,
		status: "open",
		type,
		priority: "medium",
		repoId: effectiveRepoId,
		createdAt: now,
		updatedAt: now,
		...partial,
		// Ensure these can't be overridden
		id: id,
		type,
		repoId: effectiveRepoId,
		createdAt: partial?.createdAt ?? now,
		updatedAt: now,
	};
}

/**
 * Extract a short display name from a repoId.
 * "global" → "personal"
 * "work" → "work"
 * "reviews" → "reviews"
 * "pedroklein__dotfiles" → "dotfiles"
 */
export function shortRepoName(repoId: string): string {
	if (repoId === GLOBAL_REPO_ID) return "personal";
	if (repoId === WORK_REPO_ID) return "work";
	if (repoId === REVIEW_REPO_ID) return "reviews";

	// Split on "__" separator: "pedroklein__dotfiles" → "dotfiles"
	const sep = repoId.indexOf("__");
	if (sep !== -1 && sep + 2 < repoId.length) {
		return repoId.slice(sep + 2);
	}
	return repoId;
}

/**
 * Get tasks for a repo, including global (personal) and review tasks.
 * When viewing a specific repo: repo tasks + personal + work + reviews.
 * When viewing global, work, or reviews scope directly: just those tasks.
 */
export function getTasksForRepoWithGlobals(tasks: Task[], repoId: string): Task[] {
	if (repoId === GLOBAL_REPO_ID || repoId === WORK_REPO_ID || repoId === REVIEW_REPO_ID) {
		return tasks.filter((t) => t.repoId === repoId);
	}
	return tasks.filter(
		(t) => t.repoId === repoId || t.repoId === GLOBAL_REPO_ID || t.repoId === WORK_REPO_ID || t.repoId === REVIEW_REPO_ID
	);
}

/**
 * Get tasks for exactly one scope (no mixing).
 */
export function getTasksForScope(tasks: Task[], scope: string): Task[] {
	return tasks.filter((t) => t.repoId === scope);
}

/**
 * Get all unique scopes present in tasks, ordered: current repo first,
 * then personal, work, reviews, then other repos alphabetically.
 */
export function getAllScopes(tasks: Task[], currentRepoId: string): string[] {
	const scopes = new Set<string>();
	for (const t of tasks) {
		scopes.add(t.repoId);
	}
	// Ensure current + special scopes always appear
	scopes.add(currentRepoId);
	scopes.add(GLOBAL_REPO_ID);
	scopes.add(WORK_REPO_ID);
	scopes.add(REVIEW_REPO_ID);

	// Order: current, personal, work, reviews, then alphabetical rest
	const special = [currentRepoId, GLOBAL_REPO_ID, WORK_REPO_ID, REVIEW_REPO_ID];
	const rest = [...scopes].filter((s) => !special.includes(s)).sort();
	// Deduplicate (in case currentRepoId is one of the special ones)
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const s of [...special, ...rest]) {
		if (!seen.has(s)) {
			ordered.push(s);
			seen.add(s);
		}
	}
	return ordered;
}

/**
 * Get the urgency level of a task for sorting and coloring.
 */
export function getTaskUrgency(task: Task): "overdue" | "due-soon" | "done" | "blocked" | "normal" {
	if (task.status === "done") return "done";
	if (task.status === "blocked") return "blocked";

	if (task.dueDate) {
		const now = Date.now();
		const due = new Date(task.dueDate + "T23:59:59").getTime();
		if (due < now) return "overdue";
		if (due - now < 48 * 60 * 60 * 1000) return "due-soon";
	}

	return "normal";
}

/**
 * Sort tasks: urgency-first, then priority desc, then creation date.
 */
export function sortTasksByUrgency(tasks: Task[]): Task[] {
	const urgencyOrder: Record<string, number> = {
		overdue: 0,
		"due-soon": 1,
		blocked: 2,
		normal: 3,
		done: 4,
	};
	const priorityOrder: Record<string, number> = {
		high: 0,
		medium: 1,
		low: 2,
	};

	return [...tasks].sort((a, b) => {
		const ua = urgencyOrder[getTaskUrgency(a)] ?? 3;
		const ub = urgencyOrder[getTaskUrgency(b)] ?? 3;
		if (ua !== ub) return ua - ub;

		const pa = priorityOrder[a.priority] ?? 1;
		const pb = priorityOrder[b.priority] ?? 1;
		if (pa !== pb) return pa - pb;

		return a.createdAt - b.createdAt;
	});
}

/**
 * Filter tasks by status filter.
 */
export function filterByStatus(tasks: Task[], filter: StatusFilter): Task[] {
	switch (filter) {
		case "active":
			return tasks.filter((t) => t.status !== "done");
		case "open":
			return tasks.filter((t) => t.status === "open");
		case "blocked":
			return tasks.filter((t) => t.status === "blocked");
		case "done":
			return tasks.filter((t) => t.status === "done");
		case "all":
			return tasks;
	}
}

/**
 * Get tasks for a given type, filtered and sorted.
 */
export function getTasksForType(
	tasks: Task[],
	type: TaskType,
	filter: StatusFilter
): Task[] {
	const typeTasks = tasks.filter((t) => t.type === type);
	return sortTasksByUrgency(filterByStatus(typeTasks, filter));
}

/**
 * Get summary counters for a set of tasks.
 */
export function getCounters(tasks: Task[]): {
	overdue: number;
	dueSoon: number;
	open: number;
	blocked: number;
	done: number;
} {
	let overdue = 0;
	let dueSoon = 0;
	let open = 0;
	let blocked = 0;
	let done = 0;

	for (const task of tasks) {
		const urgency = getTaskUrgency(task);
		switch (urgency) {
			case "overdue":
				overdue++;
				break;
			case "due-soon":
				dueSoon++;
				break;
			case "done":
				done++;
				break;
			case "blocked":
				blocked++;
				break;
			case "normal":
				open++;
				break;
		}
	}

	return { overdue, dueSoon, open, blocked, done };
}
