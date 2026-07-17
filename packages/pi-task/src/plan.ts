/**
 * Plan data model, DAG resolution, and in-memory operations.
 *
 * Two-level hierarchy:
 * - PlanTask: feature-level tasks with dependencies
 * - PlanSubtask: TDD-sized sub-tasks within a task
 *
 * DAG resolution: a task is "ready" when all its dependsOn tasks are "done".
 * A task is "blocked" when at least one dependency is not "done" and none are "blocked" themselves
 * (transitively blocked).
 */

// ─── Types ─────────────────────────────────────────────────────────────

export type PlanStatus = "active" | "archived" | "draft";

export type TaskStatus = "pending" | "ready" | "in-progress" | "done" | "skipped" | "blocked";

export interface PlanSubtask {
	id: string;
	title: string;
	description?: string;
	status: TaskStatus;
	tddBehavior?: string;
}

export interface TaskReferences {
	/** Skill names/paths to load before starting work */
	skills?: string[];
	/** Files to read before starting (source, configs, docs) */
	files?: string[];
	/** pi-repos references for context */
	repos?: string[];
	/** External documentation URLs to consult */
	docs?: string[];
	/** Memory keys/queries to search */
	memory?: string[];
	/** Related task IDs for context */
	related?: string[];
}

export interface TaskAnnotation {
	timestamp: number;
	text: string;
}

export interface PlanTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	order: number;
	dependsOn: string[];
	files?: string[];
	tddNotes?: string;
	parallelGroup?: string;
	/** Context references: skills, files, repos, docs, memory, related tasks */
	references?: TaskReferences;
	/** Testable acceptance criteria defining 'done' for independent verification */
	acceptanceCriteria?: string[];
	/** Whether acceptance criteria are frozen (immutable until unfrozen) */
	frozen?: boolean;
	/** Non-goals: explicitly out of scope for this task */
	nonGoals?: string[];
	/** Known constraints or danger zones */
	constraints?: string[];
	annotations: TaskAnnotation[];
	subtasks: PlanSubtask[];
}

export interface PlanGraph {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	status: PlanStatus;
	sourceCheckpoint?: string;
	tasks: PlanTask[];
	activeTaskId?: string;
	/** Snapshot of previous task states for plan diff */
	previousRevision?: PlanTaskSnapshot[];
}

export interface PlanTaskSnapshot {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	dependsOn: string[];
	subtaskCount: number;
}

export interface PlanDiffEntry {
	taskId: string;
	kind: "added" | "removed" | "modified";
	changes?: string[];
}

export interface ActivePlanRef {
	planName: string;
	updatedAt: number;
}

// ─── Defaults / Factories ──────────────────────────────────────────────

export function createPlanGraph(params: {
	name: string;
	tasks?: PlanTask[];
	sourceCheckpoint?: string;
}): PlanGraph {
	const now = Date.now();
	const id = slugify(params.name) + "::" + now;
	return {
		id,
		name: params.name,
		createdAt: now,
		updatedAt: now,
		status: "active",
		sourceCheckpoint: params.sourceCheckpoint,
		tasks: params.tasks ?? [],
	};
}

export function createPlanTask(params: {
	id: string;
	title: string;
	description: string;
	order: number;
	dependsOn?: string[];
	files?: string[];
	tddNotes?: string;
	parallelGroup?: string;
	references?: TaskReferences;
	acceptanceCriteria?: string[];
	nonGoals?: string[];
	constraints?: string[];
	subtasks?: PlanSubtask[];
}): PlanTask {
	return {
		id: params.id,
		title: params.title,
		description: params.description,
		status: "pending",
		order: params.order,
		dependsOn: params.dependsOn ?? [],
		files: params.files,
		tddNotes: params.tddNotes,
		parallelGroup: params.parallelGroup,
		references: params.references,
		acceptanceCriteria: params.acceptanceCriteria,
		nonGoals: params.nonGoals,
		constraints: params.constraints,
		annotations: [],
		subtasks: params.subtasks ?? [],
	};
}

export function createPlanSubtask(params: {
	id: string;
	title: string;
	description?: string;
	tddBehavior?: string;
}): PlanSubtask {
	return {
		id: params.id,
		title: params.title,
		description: params.description,
		status: "pending",
		tddBehavior: params.tddBehavior,
	};
}

// ─── DAG Resolution ────────────────────────────────────────────────────

/**
 * Resolve the computed status of all tasks in the graph based on dependencies.
 * Returns a new task array with statuses updated — does NOT mutate input.
 *
 * Rules:
 * - If task.status is "done" or "skipped", leave it alone.
 * - If task.status is "in-progress", leave it alone.
 * - If all dependsOn tasks are "done" or "skipped" → "ready"
 * - If any dependsOn task is not "done"/"skipped" → "blocked" (unless manually set)
 * - Tasks with no dependencies start as "ready" if still "pending"
 */
export function resolveTaskStatuses(tasks: PlanTask[]): PlanTask[] {
	const statusMap = new Map<string, TaskStatus>();
	for (const task of tasks) {
		statusMap.set(task.id, task.status);
	}

	return tasks.map((task) => {
		// Terminal states are not overridden
		if (task.status === "done" || task.status === "skipped" || task.status === "in-progress") {
			return task;
		}

		// Check dependencies
		if (task.dependsOn.length === 0) {
			// No deps: if pending, becomes ready
			return task.status === "pending" ? { ...task, status: "ready" as TaskStatus } : task;
		}

		const allDepsSatisfied = task.dependsOn.every((depId) => {
			const depStatus = statusMap.get(depId);
			return depStatus === "done" || depStatus === "skipped";
		});

		if (allDepsSatisfied) {
			return task.status === "pending" || task.status === "blocked"
				? { ...task, status: "ready" as TaskStatus }
				: task;
		}

		// Not all deps satisfied
		return task.status === "pending" || task.status === "ready"
			? { ...task, status: "blocked" as TaskStatus }
			: task;
	});
}

/**
 * Get tasks that are ready to execute, sorted by order.
 */
export function getReadyTasks(graph: PlanGraph): PlanTask[] {
	const resolved = resolveTaskStatuses(graph.tasks);
	return resolved.filter((t) => t.status === "ready").sort((a, b) => a.order - b.order);
}

/**
 * Get the next task to work on: the active task if set, otherwise first ready task.
 */
export function getNextTask(graph: PlanGraph): PlanTask | null {
	if (graph.activeTaskId) {
		const active = graph.tasks.find((t) => t.id === graph.activeTaskId);
		if (active && active.status !== "done" && active.status !== "skipped") return active;
	}
	const ready = getReadyTasks(graph);
	return ready[0] ?? null;
}

/**
 * Count tasks by status.
 */
export function getTaskCounts(graph: PlanGraph): {
	total: number;
	done: number;
	ready: number;
	blocked: number;
	inProgress: number;
	pending: number;
	skipped: number;
} {
	const resolved = resolveTaskStatuses(graph.tasks);
	let done = 0, ready = 0, blocked = 0, inProgress = 0, pending = 0, skipped = 0;
	for (const t of resolved) {
		switch (t.status) {
			case "done": done++; break;
			case "ready": ready++; break;
			case "blocked": blocked++; break;
			case "in-progress": inProgress++; break;
			case "pending": pending++; break;
			case "skipped": skipped++; break;
		}
	}
	return { total: resolved.length, done, ready, blocked, inProgress, pending, skipped };
}

// ─── Validation ────────────────────────────────────────────────────────

export interface ValidationError {
	taskId?: string;
	message: string;
}

/**
 * Validate a plan graph for structural issues:
 * - duplicate task IDs
 * - missing dependency targets
 * - dependency cycles
 * - duplicate subtask IDs within a task
 */
export function validatePlanGraph(graph: PlanGraph): ValidationError[] {
	const errors: ValidationError[] = [];

	// Check duplicate task IDs
	const taskIds = new Set<string>();
	for (const task of graph.tasks) {
		if (taskIds.has(task.id)) {
			errors.push({ taskId: task.id, message: `Duplicate task ID: ${task.id}` });
		}
		taskIds.add(task.id);
	}

	// Check missing dependency targets
	for (const task of graph.tasks) {
		for (const depId of task.dependsOn) {
			if (!taskIds.has(depId)) {
				errors.push({ taskId: task.id, message: `Depends on unknown task: ${depId}` });
			}
		}
	}

	// Check dependency cycles
	const cycleErrors = detectCycles(graph.tasks);
	errors.push(...cycleErrors);

	// Check duplicate subtask IDs within tasks
	for (const task of graph.tasks) {
		const subtaskIds = new Set<string>();
		for (const sub of task.subtasks) {
			if (subtaskIds.has(sub.id)) {
				errors.push({ taskId: task.id, message: `Duplicate subtask ID: ${sub.id} in task ${task.id}` });
			}
			subtaskIds.add(sub.id);
		}
	}

	// Warn about file overlaps within parallel groups
	const groups = new Map<string, PlanTask[]>();
	for (const task of graph.tasks) {
		if (task.parallelGroup) {
			const group = groups.get(task.parallelGroup) ?? [];
			group.push(task);
			groups.set(task.parallelGroup, group);
		}
	}
	for (const [groupName, tasks] of groups) {
		const seenFiles = new Map<string, string>(); // file → task that owns it
		for (const task of tasks) {
			for (const file of task.files ?? []) {
				const owner = seenFiles.get(file);
				if (owner) {
					errors.push({
						taskId: task.id,
						message: `File overlap in parallelGroup "${groupName}": ${file} is in both ${owner} and ${task.id}`,
					});
				} else {
					seenFiles.set(file, task.id);
				}
			}
		}
	}

	return errors;
}

function detectCycles(tasks: PlanTask[]): ValidationError[] {
	const errors: ValidationError[] = [];
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const visited = new Set<string>();
	const inStack = new Set<string>();

	function dfs(taskId: string, path: string[]): boolean {
		if (inStack.has(taskId)) {
			const cycleStart = path.indexOf(taskId);
			const cycle = path.slice(cycleStart).concat(taskId);
			errors.push({
				taskId,
				message: `Dependency cycle detected: ${cycle.join(" → ")}`,
			});
			return true;
		}
		if (visited.has(taskId)) return false;

		visited.add(taskId);
		inStack.add(taskId);
		const task = taskMap.get(taskId);
		if (task) {
			for (const depId of task.dependsOn) {
				if (taskMap.has(depId)) {
					dfs(depId, [...path, taskId]);
				}
			}
		}
		inStack.delete(taskId);
		return false;
	}

	for (const task of tasks) {
		if (!visited.has(task.id)) {
			dfs(task.id, []);
		}
	}

	return errors;
}

// ─── Mutations (return new graph, never mutate) ────────────────────────

/**
 * Update a task's status. Returns a new graph.
 * When completing a parent task, all non-terminal sub-tasks are also marked done.
 */
export function setTaskStatus(graph: PlanGraph, taskId: string, status: TaskStatus): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;

	const task = graph.tasks[taskIndex];
	const updatedTasks = [...graph.tasks];

	// When completing a parent task, cascade to sub-tasks
	if (status === "done" && task.subtasks.length > 0) {
		const updatedSubtasks = task.subtasks.map((s) =>
			s.status === "done" || s.status === "skipped" ? s : { ...s, status: "done" as TaskStatus },
		);
		updatedTasks[taskIndex] = { ...task, status, subtasks: updatedSubtasks };
	} else if (status === "skipped" && task.subtasks.length > 0) {
		const updatedSubtasks = task.subtasks.map((s) =>
			s.status === "done" || s.status === "skipped" ? s : { ...s, status: "skipped" as TaskStatus },
		);
		updatedTasks[taskIndex] = { ...task, status, subtasks: updatedSubtasks };
	} else {
		updatedTasks[taskIndex] = { ...task, status };
	}

	return {
		...graph,
		tasks: resolveTaskStatuses(updatedTasks),
		updatedAt: Date.now(),
	};
}

/**
 * Update a subtask's status. Returns a new graph.
 */
export function setSubtaskStatus(
	graph: PlanGraph,
	taskId: string,
	subtaskId: string,
	status: TaskStatus,
): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;
	const task = graph.tasks[taskIndex];
	const subIndex = task.subtasks.findIndex((s) => s.id === subtaskId);
	if (subIndex === -1) return graph;

	const updatedSubtasks = [...task.subtasks];
	updatedSubtasks[subIndex] = { ...updatedSubtasks[subIndex], status };

	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...task, subtasks: updatedSubtasks };

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Add an annotation to a task. Returns a new graph.
 */
export function addTaskAnnotation(graph: PlanGraph, taskId: string, text: string): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;
	const task = graph.tasks[taskIndex];

	const annotation: TaskAnnotation = { timestamp: Date.now(), text };
	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...task, annotations: [...task.annotations, annotation] };

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Set the active task. Returns a new graph.
 */
export function setActiveTask(graph: PlanGraph, taskId: string | undefined): PlanGraph {
	return { ...graph, activeTaskId: taskId, updatedAt: Date.now() };
}

/**
 * Expand a task: replace it with new sub-tasks (or add subtasks to existing task).
 * Returns a new graph.
 */
export function expandTaskSubtasks(
	graph: PlanGraph,
	taskId: string,
	newSubtasks: PlanSubtask[],
): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;
	const task = graph.tasks[taskIndex];

	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = {
		...task,
		subtasks: [...task.subtasks, ...newSubtasks],
	};

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Update a task's fields. Returns a new graph.
 */
export function updateTask(
	graph: PlanGraph,
	taskId: string,
	updates: Partial<Pick<PlanTask, "title" | "description" | "dependsOn" | "files" | "tddNotes" | "parallelGroup" | "order" | "references" | "acceptanceCriteria" | "nonGoals" | "constraints">>,
): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;

	const task = graph.tasks[taskIndex];

	// Block updates to acceptanceCriteria when task is frozen
	if (task.frozen && updates.acceptanceCriteria !== undefined) {
		throw new Error(`Task ${taskId} is frozen. Unfreeze it before modifying acceptance criteria.`);
	}

	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...updatedTasks[taskIndex], ...updates };

	return {
		...graph,
		tasks: resolveTaskStatuses(updatedTasks),
		updatedAt: Date.now(),
	};
}

// ─── Freeze / Unfreeze ─────────────────────────────────────────────────

/**
 * Freeze acceptance criteria for a task (or all tasks). Frozen criteria cannot be
 * modified until unfrozen. Validates that criteria exist before freezing.
 */
export function freezeTask(graph: PlanGraph, taskId: string): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) throw new Error(`Task not found: ${taskId}`);

	const task = graph.tasks[taskIndex];
	if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
		throw new Error(`Cannot freeze task ${taskId}: no acceptance criteria defined. Add criteria first.`);
	}
	if (task.frozen) return graph; // Already frozen, no-op

	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...task, frozen: true };

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Freeze all tasks that have acceptance criteria.
 * Returns the updated graph and a list of tasks that couldn't be frozen (no criteria).
 */
export function freezeAllTasks(graph: PlanGraph): { graph: PlanGraph; skipped: string[] } {
	const skipped: string[] = [];
	const updatedTasks = graph.tasks.map((task) => {
		if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
			skipped.push(task.id);
			return task;
		}
		if (task.frozen) return task;
		return { ...task, frozen: true };
	});

	return {
		graph: { ...graph, tasks: updatedTasks, updatedAt: Date.now() },
		skipped,
	};
}

/**
 * Unfreeze a task, allowing criteria modification.
 */
export function unfreezeTask(graph: PlanGraph, taskId: string): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) throw new Error(`Task not found: ${taskId}`);

	const task = graph.tasks[taskIndex];
	if (!task.frozen) return graph; // Already unfrozen, no-op

	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...task, frozen: false };

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Add acceptance criteria to a task (convenience method).
 * Appends to existing criteria without replacing them.
 */
export function addAcceptanceCriteria(graph: PlanGraph, taskId: string, criteria: string[]): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) throw new Error(`Task not found: ${taskId}`);

	const task = graph.tasks[taskIndex];
	if (task.frozen) {
		throw new Error(`Task ${taskId} is frozen. Unfreeze it before modifying acceptance criteria.`);
	}

	const existing = task.acceptanceCriteria ?? [];
	const updatedTasks = [...graph.tasks];
	updatedTasks[taskIndex] = { ...task, acceptanceCriteria: [...existing, ...criteria] };

	return { ...graph, tasks: updatedTasks, updatedAt: Date.now() };
}

/**
 * Add new tasks to an existing plan. Returns a new graph.
 * Validates that new task IDs don't conflict with existing ones.
 */
export function addTasks(graph: PlanGraph, newTasks: PlanTask[]): PlanGraph {
	const existingIds = new Set(graph.tasks.map((t) => t.id));
	const conflicts = newTasks.filter((t) => existingIds.has(t.id));
	if (conflicts.length > 0) {
		throw new Error(`Duplicate task IDs: ${conflicts.map((t) => t.id).join(", ")}. Use 'update' to modify existing tasks.`);
	}

	const allTasks = [...graph.tasks, ...newTasks];
	return {
		...graph,
		tasks: resolveTaskStatuses(allTasks),
		updatedAt: Date.now(),
	};
}

/**
 * Set multiple tasks to a given status at once. Returns a new graph.
 * Cascades to sub-tasks like setTaskStatus does.
 */
export function bulkSetTaskStatus(graph: PlanGraph, taskIds: string[], status: TaskStatus): PlanGraph {
	const idSet = new Set(taskIds);
	const updatedTasks = graph.tasks.map((task) => {
		if (!idSet.has(task.id)) return task;

		if (status === "done" && task.subtasks.length > 0) {
			const updatedSubtasks = task.subtasks.map((s) =>
				s.status === "done" || s.status === "skipped" ? s : { ...s, status: "done" as TaskStatus },
			);
			return { ...task, status, subtasks: updatedSubtasks };
		}
		if (status === "skipped" && task.subtasks.length > 0) {
			const updatedSubtasks = task.subtasks.map((s) =>
				s.status === "done" || s.status === "skipped" ? s : { ...s, status: "skipped" as TaskStatus },
			);
			return { ...task, status, subtasks: updatedSubtasks };
		}
		return { ...task, status };
	});

	return {
		...graph,
		tasks: resolveTaskStatuses(updatedTasks),
		updatedAt: Date.now(),
	};
}

// ─── Plan Diff ─────────────────────────────────────────────────────────

/**
 * Take a snapshot of current task states for diff tracking.
 */
export function snapshotTasks(graph: PlanGraph): PlanTaskSnapshot[] {
	return graph.tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		status: t.status,
		dependsOn: [...t.dependsOn],
		subtaskCount: t.subtasks.length,
	}));
}

/**
 * Save current state as previous revision (before an update).
 */
export function savePreviousRevision(graph: PlanGraph): PlanGraph {
	return { ...graph, previousRevision: snapshotTasks(graph) };
}

/**
 * Compute diff between current state and previous revision.
 */
export function computePlanDiff(graph: PlanGraph): PlanDiffEntry[] {
	if (!graph.previousRevision) return [];

	const diffs: PlanDiffEntry[] = [];
	const prevMap = new Map(graph.previousRevision.map((s) => [s.id, s]));
	const currIds = new Set(graph.tasks.map((t) => t.id));

	for (const task of graph.tasks) {
		const prev = prevMap.get(task.id);
		if (!prev) {
			diffs.push({ taskId: task.id, kind: "added" });
			continue;
		}

		const changes: string[] = [];
		if (prev.title !== task.title) changes.push("title");
		if (prev.description !== task.description) changes.push("description");
		if (prev.status !== task.status) changes.push(`status: ${prev.status} → ${task.status}`);
		if (JSON.stringify(prev.dependsOn) !== JSON.stringify(task.dependsOn)) changes.push("dependencies");
		if (prev.subtaskCount !== task.subtasks.length) changes.push(`subtasks: ${prev.subtaskCount} → ${task.subtasks.length}`);

		if (changes.length > 0) {
			diffs.push({ taskId: task.id, kind: "modified", changes });
		}
	}

	for (const prev of graph.previousRevision) {
		if (!currIds.has(prev.id)) {
			diffs.push({ taskId: prev.id, kind: "removed" });
		}
	}

	return diffs;
}

// ─── Scope Creep Detection ─────────────────────────────────────────────

/**
 * Check if a set of modified files deviates from the plan's expected files.
 * Returns file paths that were touched but aren't in any task's files list.
 */
export function detectScopeCreep(graph: PlanGraph, modifiedFiles: string[]): string[] {
	const plannedFiles = new Set<string>();
	for (const task of graph.tasks) {
		if (task.files) {
			for (const f of task.files) {
				plannedFiles.add(f);
			}
		}
	}

	if (plannedFiles.size === 0) return []; // No file tracking, can't detect creep

	return modifiedFiles.filter((f) => !plannedFiles.has(f));
}

/**
 * Try to auto-detect which task was completed based on files edited.
 * Returns task IDs where ALL listed files were touched.
 */
export function matchTasksByFiles(graph: PlanGraph, editedFiles: string[]): string[] {
	const editedSet = new Set(editedFiles);
	const matches: string[] = [];

	for (const task of graph.tasks) {
		if (!task.files || task.files.length === 0) continue;
		if (task.status === "done" || task.status === "skipped") continue;

		const allTouched = task.files.every((f) => editedSet.has(f));
		if (allTouched) matches.push(task.id);
	}

	return matches;
}

// ─── Formatting ────────────────────────────────────────────────────────

const STATUS_ICONS: Record<TaskStatus, string> = {
	pending: "⏳",
	ready: "🔓",
	"in-progress": "🔧",
	done: "✅",
	skipped: "⏭",
	blocked: "🔒",
};

/**
 * Format a plan graph as readable text for the agent/user.
 */
export function formatPlanGraphText(graph: PlanGraph): string {
	const resolved = resolveTaskStatuses(graph.tasks);
	const counts = getTaskCounts(graph);
	const lines: string[] = [];

	lines.push(`# Plan: ${graph.name}`);
	lines.push(`Status: ${graph.status} | Tasks: ${counts.done}/${counts.total} done | Ready: ${counts.ready} | Blocked: ${counts.blocked}`);
	if (graph.activeTaskId) lines.push(`Active task: ${graph.activeTaskId}`);
	lines.push("");

	const sorted = [...resolved].sort((a, b) => a.order - b.order);
	for (const task of sorted) {
		const icon = STATUS_ICONS[task.status] ?? "?";
		const deps = task.dependsOn.length > 0 ? ` [depends: ${task.dependsOn.join(", ")}]` : "";
		const parallel = task.parallelGroup ? ` [parallel: ${task.parallelGroup}]` : "";
		const frozen = task.frozen ? " 🧊" : "";
		const files = task.files?.length ? ` files: ${task.files.join(", ")}` : "";
		lines.push(`${icon} ${task.id}: ${task.title} (${task.status})${frozen}${deps}${parallel}`);
		if (task.description) lines.push(`   ${task.description}`);
		if (files) lines.push(`  ${files}`);
		if (task.tddNotes) lines.push(`   TDD: ${task.tddNotes}`);

		if (task.acceptanceCriteria?.length) {
			lines.push(`   Acceptance Criteria${task.frozen ? " (frozen)" : ""}:`);
			for (const ac of task.acceptanceCriteria) {
				lines.push(`     • ${ac}`);
			}
		}

		if (task.references) {
			const refs = task.references;
			const refParts: string[] = [];
			if (refs.skills?.length) refParts.push(`skills: ${refs.skills.join(", ")}`);
			if (refs.files?.length) refParts.push(`files: ${refs.files.join(", ")}`);
			if (refs.repos?.length) refParts.push(`repos: ${refs.repos.join(", ")}`);
			if (refs.docs?.length) refParts.push(`docs: ${refs.docs.join(", ")}`);
			if (refs.memory?.length) refParts.push(`memory: ${refs.memory.join(", ")}`);
			if (refs.related?.length) refParts.push(`related: ${refs.related.join(", ")}`);
			if (refParts.length > 0) lines.push(`   References: ${refParts.join(" | ")}`);
		}

		if (task.constraints?.length) {
			lines.push(`   Constraints: ${task.constraints.join("; ")}`);
		}
		if (task.nonGoals?.length) {
			lines.push(`   Non-goals: ${task.nonGoals.join("; ")}`);
		}

		for (const sub of task.subtasks) {
			const subIcon = STATUS_ICONS[sub.status] ?? "?";
			lines.push(`   ${subIcon} ${sub.id}: ${sub.title} (${sub.status})`);
			if (sub.tddBehavior) lines.push(`      test: ${sub.tddBehavior}`);
		}

		if (task.annotations.length > 0) {
			for (const ann of task.annotations) {
				const time = new Date(ann.timestamp).toISOString().slice(11, 19);
				lines.push(`   📝 [${time}] ${ann.text}`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Format plan as a markdown checklist (for Plannotator compatibility).
 */
export function formatPlanAsChecklist(graph: PlanGraph): string {
	const resolved = resolveTaskStatuses(graph.tasks);
	const sorted = [...resolved].sort((a, b) => a.order - b.order);
	const lines: string[] = [];

	lines.push(`# ${graph.name}`);
	lines.push("");

	for (const task of sorted) {
		const checked = task.status === "done" ? "x" : " ";
		const deps = task.dependsOn.length > 0 ? ` _(depends: ${task.dependsOn.join(", ")})_` : "";
		lines.push(`## ${task.id}: ${task.title}`);
		lines.push("");
		if (task.description) lines.push(task.description);
		if (deps) lines.push(deps);
		lines.push("");

		if (task.subtasks.length > 0) {
			for (const sub of task.subtasks) {
				const subChecked = sub.status === "done" ? "x" : " ";
				const tdd = sub.tddBehavior ? ` — test: ${sub.tddBehavior}` : "";
				lines.push(`- [${subChecked}] ${sub.id}: ${sub.title}${tdd}`);
			}
		} else {
			lines.push(`- [${checked}] ${task.title}`);
		}

		if (task.tddNotes) {
			lines.push("");
			lines.push(`> TDD: ${task.tddNotes}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Helpers ───────────────────────────────────────────────────────────

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-_]/g, "")
		.slice(0, 60) || "plan";
}
