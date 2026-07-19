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

/**
 * Executor hint for a task or phase. Cascades: plan → phase.defaults → phase → task.
 *
 * - `any`     — no preference; run wherever convenient (default).
 * - `inline`  — run in the current agent's context; do not spawn a subagent.
 * - `subagent-fresh` — spawn a fresh-context subagent (no parent history).
 * - `subagent-fork`  — spawn a forked-context subagent (shares parent context).
 * - `user`    — human executes; agent should hand off.
 *
 * See `design-briefs/plan-tasks-executor-field.md`.
 */
export type TaskExecutor = "any" | "inline" | "subagent-fresh" | "subagent-fork" | "user";

/**
 * Reserved phase ID for the implicit root phase.
 * Tasks with `phaseId === undefined` belong here. User-defined phases may not
 * use this ID; `validatePlanGraph` rejects that.
 */
export const ROOT_PHASE_ID = "_root";

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

/**
 * Category for task/phase annotations. Runtime auto-annotations always use
 * `"divergence"`. User annotations may pick any category or omit for `"note"`.
 */
export type AnnotationCategory = "note" | "divergence" | "blocker" | "decision";

export const ANNOTATION_CATEGORIES: readonly AnnotationCategory[] = [
	"note",
	"divergence",
	"blocker",
	"decision",
] as const;

export interface TaskAnnotation {
	timestamp: number;
	text: string;
	category?: AnnotationCategory;
}

/**
 * Phase-scoped annotation. Distinct from TaskAnnotation so audit tools can
 * scope diffs to a phase without task-vs-phase disambiguation.
 *
 * `category` is optional; the primary use case is `"divergence"` — noting
 * where implementation deviated from the phase's design spec.
 */
export interface PhaseAnnotation {
	timestamp: number;
	text: string;
	category?: AnnotationCategory;
}

/**
 * Defaults inherited by tasks in a phase. Lower priority than task-level fields.
 * See `docs/design/phases.md` for the cascade order.
 *
 * Cascade rules (per P1.3):
 *  - Scalars (executor, parallelGroup): task overrides phase overrides plan.
 *  - Arrays (referenceSkills/Files, constraints, nonGoals, acceptanceCriteria):
 *    concatenated with dedupe by string equality. Task-level array is prepended,
 *    then phase, then plan. Duplicates are collapsed keeping the first occurrence.
 */
export interface PhaseDefaults {
	executor?: TaskExecutor;
	parallelGroup?: string;
	referenceSkills?: string[];
	referenceFiles?: string[];
	constraints?: string[];
	nonGoals?: string[];
	acceptanceCriteria?: string[];
}

/**
 * Plan-level defaults. Lowest priority in the executor / parallel-group cascade.
 */
export interface PlanDefaults {
	executor?: TaskExecutor;
	referenceSkills?: string[];
	referenceFiles?: string[];
	constraints?: string[];
	nonGoals?: string[];
	acceptanceCriteria?: string[];
}

/**
 * First-class phase entity. Sits between the plan and its tasks. Tasks reference
 * a phase via `PlanTask.phaseId`. Phases form their own DAG.
 *
 * Existing plans without any phases behave as if they contain a single implicit
 * `_root` phase — see `ROOT_PHASE_ID`. This is a read-time convenience; the
 * `_root` phase is not persisted.
 */
export interface Phase {
	id: string;
	title: string;
	description: string;
	order: number;
	dependsOn: string[];
	/** Phase-level acceptance criteria, verified by `phase-verify`. */
	acceptanceCriteria?: string[];
	/** Executor for phase-scoped work (phase-verify reviewer spawns, etc.). */
	executor?: TaskExecutor;
	defaults?: PhaseDefaults;
	frozen?: boolean;
	annotations: PhaseAnnotation[];
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
	/**
	 * Phase this task belongs to. Absence means the implicit `_root` phase.
	 * Referential integrity is enforced by `validatePlanGraph`.
	 */
	phaseId?: string;
	/**
	 * Task-level executor override. Highest priority in the cascade.
	 * See `TaskExecutor` for values and `docs/design/phases.md` for cascade rules.
	 */
	executor?: TaskExecutor;
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
	/**
	 * First-class phases. Optional — absent/empty means all tasks belong to the
	 * implicit `_root` phase. See `getEffectivePhases` for the read-time materialisation.
	 */
	phases?: Phase[];
	/** Plan-level defaults (lowest priority in the cascade). */
	defaults?: PlanDefaults;
	/**
	 * Absolute path to a per-plan scratch directory. If unset, callers should
	 * derive the default via `defaultScratchDir(planName, plansRoot)`. The
	 * `{scratchDir}` template variable expands to this path in references and
	 * constraints. See P2.6.
	 */
	scratchDir?: string;
	/**
	 * Plan-level freeze bit. Set to `true` on first `start` (implicit freeze).
	 * Distinct from per-task `PlanTask.frozen`. See P2.4.
	 */
	frozen?: boolean;
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
	phaseId?: string;
	executor?: TaskExecutor;
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
		phaseId: params.phaseId,
		executor: params.executor,
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

// ─── Phase helpers ─────────────────────────────────────────────────────

/**
 * Return the plan's phases with the implicit `_root` phase materialised.
 *
 * Contract:
 * - If `graph.phases` is missing or empty, returns a single `_root` phase.
 * - Otherwise, returns `graph.phases` as-is (no `_root` injected — user phases only).
 * - Never mutates the input graph.
 */
export function getEffectivePhases(graph: PlanGraph): Phase[] {
	if (graph.phases && graph.phases.length > 0) {
		return graph.phases;
	}
	return [
		{
			id: ROOT_PHASE_ID,
			title: "Root",
			description: "Implicit root phase for tasks without a phaseId.",
			order: 0,
			dependsOn: [],
			annotations: [],
		},
	];
}

/**
 * Resolve a task's effective executor by walking the cascade:
 *   plan.defaults.executor → phase.defaults.executor → phase.executor → task.executor
 * Highest priority wins. Falls back to `"any"`.
 */
export function resolveTaskExecutor(graph: PlanGraph, task: PlanTask): TaskExecutor {
	if (task.executor) return task.executor;

	const phaseId = task.phaseId ?? ROOT_PHASE_ID;
	const phase = getEffectivePhases(graph).find((p) => p.id === phaseId);

	if (phase) {
		if (phase.executor) return phase.executor;
		if (phase.defaults?.executor) return phase.defaults.executor;
	}

	if (graph.defaults?.executor) return graph.defaults.executor;
	return "any";
}

/**
 * Snapshot of a task's fields with all cascading defaults applied.
 * Returned by `resolveTaskDefaults`. Scalar fields hold the highest-priority
 * value; array fields hold the concat-dedupe merge.
 */
export interface ResolvedTaskFields {
	executor: TaskExecutor;
	parallelGroup?: string;
	referenceSkills: string[];
	referenceFiles: string[];
	constraints: string[];
	nonGoals: string[];
	acceptanceCriteria: string[];
}

function dedupeConcat(...lists: (string[] | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		if (!list) continue;
		for (const value of list) {
			if (seen.has(value)) continue;
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

/**
 * Resolve all cascadable fields for a task. Scalars follow task → phase → plan;
 * arrays are concat-deduped in the same priority order (task-level values first).
 *
 * This is what `plan_tasks get --verbose` returns as the `resolved` snapshot.
 */
export function resolveTaskDefaults(graph: PlanGraph, task: PlanTask): ResolvedTaskFields {
	const phaseId = task.phaseId ?? ROOT_PHASE_ID;
	const phase = getEffectivePhases(graph).find((p) => p.id === phaseId);
	const phaseDefaults = phase?.defaults;
	const planDefaults = graph.defaults;

	return {
		executor: resolveTaskExecutor(graph, task),
		parallelGroup: task.parallelGroup ?? phaseDefaults?.parallelGroup,
		referenceSkills: dedupeConcat(
			task.references?.skills,
			phaseDefaults?.referenceSkills,
			planDefaults?.referenceSkills,
		),
		referenceFiles: dedupeConcat(
			task.references?.files,
			phaseDefaults?.referenceFiles,
			planDefaults?.referenceFiles,
		),
		constraints: dedupeConcat(
			task.constraints,
			phaseDefaults?.constraints,
			planDefaults?.constraints,
		),
		nonGoals: dedupeConcat(
			task.nonGoals,
			phaseDefaults?.nonGoals,
			planDefaults?.nonGoals,
		),
		acceptanceCriteria: dedupeConcat(
			task.acceptanceCriteria,
			phaseDefaults?.acceptanceCriteria,
			planDefaults?.acceptanceCriteria,
		),
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

	// Validate phases: reserved-id, duplicate-id, dependsOn integrity, cycles, task→phase FK
	errors.push(...validatePhases(graph));

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

/**
 * Validate phase-related integrity:
 *  - phase IDs are unique
 *  - user phases don't use the reserved `_root` ID
 *  - phase `dependsOn` targets exist
 *  - the phase DAG is acyclic
 *  - every task's `phaseId` (when set) targets an existing phase
 */
function validatePhases(graph: PlanGraph): ValidationError[] {
	const errors: ValidationError[] = [];
	const phases = graph.phases ?? [];

	const phaseIds = new Set<string>();
	for (const phase of phases) {
		if (phase.id === ROOT_PHASE_ID) {
			errors.push({ message: `Phase ID "${ROOT_PHASE_ID}" is reserved for the implicit root phase.` });
		}
		if (phaseIds.has(phase.id)) {
			errors.push({ message: `Duplicate phase ID: ${phase.id}` });
		}
		phaseIds.add(phase.id);
	}

	// The implicit root is always a valid target, whether or not the user
	// declared any phases.
	const validPhaseTargets = new Set<string>([...phaseIds, ROOT_PHASE_ID]);

	for (const phase of phases) {
		for (const depId of phase.dependsOn) {
			if (!validPhaseTargets.has(depId)) {
				errors.push({ message: `Phase ${phase.id} depends on unknown phase: ${depId}` });
			}
		}
	}

	errors.push(...detectPhaseCycles(phases));

	for (const task of graph.tasks) {
		if (task.phaseId && !validPhaseTargets.has(task.phaseId)) {
			errors.push({
				taskId: task.id,
				message: `Task ${task.id} references unknown phase: ${task.phaseId}`,
			});
		}
	}

	return errors;
}

function detectPhaseCycles(phases: Phase[]): ValidationError[] {
	const errors: ValidationError[] = [];
	const phaseMap = new Map(phases.map((p) => [p.id, p]));
	const visited = new Set<string>();
	const inStack = new Set<string>();

	function dfs(phaseId: string, path: string[]): void {
		if (inStack.has(phaseId)) {
			const cycleStart = path.indexOf(phaseId);
			const cycle = path.slice(cycleStart).concat(phaseId);
			errors.push({ message: `Phase dependency cycle detected: ${cycle.join(" → ")}` });
			return;
		}
		if (visited.has(phaseId)) return;

		visited.add(phaseId);
		inStack.add(phaseId);
		const phase = phaseMap.get(phaseId);
		if (phase) {
			for (const depId of phase.dependsOn) {
				if (phaseMap.has(depId)) {
					dfs(depId, [...path, phaseId]);
				}
			}
		}
		inStack.delete(phaseId);
	}

	for (const phase of phases) {
		if (!visited.has(phase.id)) {
			dfs(phase.id, []);
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
export function addTaskAnnotation(
	graph: PlanGraph,
	taskId: string,
	text: string,
	category?: AnnotationCategory,
): PlanGraph {
	const taskIndex = graph.tasks.findIndex((t) => t.id === taskId);
	if (taskIndex === -1) return graph;
	const task = graph.tasks[taskIndex];

	const annotation: TaskAnnotation = { timestamp: Date.now(), text, ...(category ? { category } : {}) };
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
	updates: Partial<Pick<PlanTask, "title" | "description" | "dependsOn" | "files" | "tddNotes" | "parallelGroup" | "order" | "references" | "acceptanceCriteria" | "nonGoals" | "constraints" | "phaseId" | "executor">>,
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

// ─── Phase mutators (P2.1–P2.2) ─────────────────────────────────────────

export interface CreatePhaseParams {
	id: string;
	title: string;
	description?: string;
	order?: number;
	dependsOn?: string[];
	acceptanceCriteria?: string[];
	executor?: TaskExecutor;
	defaults?: PhaseDefaults;
}

/** Create a new phase. Rejects duplicate IDs and the reserved `_root` ID. */
export function addPhase(graph: PlanGraph, params: CreatePhaseParams): PlanGraph {
	if (params.id === ROOT_PHASE_ID) {
		throw new Error(`Phase ID '${ROOT_PHASE_ID}' is reserved for the implicit root phase.`);
	}
	const existing = graph.phases ?? [];
	if (existing.some((p) => p.id === params.id)) {
		throw new Error(`Phase already exists: ${params.id}`);
	}
	const phase: Phase = {
		id: params.id,
		title: params.title,
		description: params.description ?? "",
		order: params.order ?? existing.length + 1,
		dependsOn: params.dependsOn ?? [],
		...(params.acceptanceCriteria ? { acceptanceCriteria: [...params.acceptanceCriteria] } : {}),
		...(params.executor ? { executor: params.executor } : {}),
		...(params.defaults ? { defaults: { ...params.defaults } } : {}),
		annotations: [],
	};
	return { ...graph, phases: [...existing, phase], updatedAt: Date.now() };
}

export interface UpdatePhaseParams {
	title?: string;
	description?: string;
	order?: number;
	dependsOn?: string[];
	acceptanceCriteria?: string[];
	executor?: TaskExecutor;
	defaults?: PhaseDefaults;
}

/** Update an existing phase. Rejects if frozen for AC edits. */
export function updatePhase(graph: PlanGraph, phaseId: string, updates: UpdatePhaseParams): PlanGraph {
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const phase = existing[idx];
	if (phase.frozen && updates.acceptanceCriteria !== undefined) {
		throw new Error(`Phase ${phaseId} is frozen; unfreeze before editing acceptance criteria.`);
	}
	const next: Phase = {
		...phase,
		...(updates.title !== undefined && { title: updates.title }),
		...(updates.description !== undefined && { description: updates.description }),
		...(updates.order !== undefined && { order: updates.order }),
		...(updates.dependsOn !== undefined && { dependsOn: [...updates.dependsOn] }),
		...(updates.acceptanceCriteria !== undefined && { acceptanceCriteria: [...updates.acceptanceCriteria] }),
		...(updates.executor !== undefined && { executor: updates.executor }),
		...(updates.defaults !== undefined && { defaults: { ...updates.defaults } }),
	};
	const nextPhases = [...existing];
	nextPhases[idx] = next;
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

/**
 * Delete a phase. Rejects if any task references the phase. Rejects on `_root`.
 * Error message names the referencing tasks.
 */
export function deletePhase(graph: PlanGraph, phaseId: string): PlanGraph {
	if (phaseId === ROOT_PHASE_ID) {
		throw new Error(`Cannot delete implicit '${ROOT_PHASE_ID}' phase.`);
	}
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const referencing = graph.tasks.filter((t) => t.phaseId === phaseId).map((t) => t.id);
	if (referencing.length > 0) {
		throw new Error(
			`Cannot delete phase ${phaseId}: still referenced by task(s): ${referencing.join(", ")}. ` +
				`Reassign those tasks first.`,
		);
	}
	// Reject if any OTHER phase depends on this one.
	const dependents = existing.filter((p) => p.dependsOn.includes(phaseId)).map((p) => p.id);
	if (dependents.length > 0) {
		throw new Error(
			`Cannot delete phase ${phaseId}: depended on by phase(s): ${dependents.join(", ")}.`,
		);
	}
	const nextPhases = existing.filter((p) => p.id !== phaseId);
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

/** Snapshot of a phase's runtime state, for `phase-status` output. */
export interface PhaseStatusReport {
	id: string;
	title: string;
	description: string;
	order: number;
	dependsOn: string[];
	executor: TaskExecutor;
	resolvedExecutor: TaskExecutor;
	frozen: boolean;
	acceptanceCriteria: string[];
	taskCounts: Record<TaskStatus, number>;
	totalTasks: number;
	annotations: PhaseAnnotation[];
}

const EMPTY_TASK_COUNTS: Record<TaskStatus, number> = {
	pending: 0,
	ready: 0,
	"in-progress": 0,
	done: 0,
	skipped: 0,
	blocked: 0,
};

/** Build a `PhaseStatusReport` for a single phase. */
export function getPhaseStatus(graph: PlanGraph, phaseId: string): PhaseStatusReport {
	const phases = getEffectivePhases(graph);
	const phase = phases.find((p) => p.id === phaseId);
	if (!phase) throw new Error(`Phase not found: ${phaseId}`);

	const tasksInPhase = graph.tasks.filter((t) => {
		if (phaseId === ROOT_PHASE_ID) return t.phaseId === undefined;
		return t.phaseId === phaseId;
	});

	const counts: Record<TaskStatus, number> = { ...EMPTY_TASK_COUNTS };
	for (const t of tasksInPhase) counts[t.status]++;

	// Resolved executor: cascade phase → plan.
	const planExecutor: TaskExecutor = graph.defaults?.executor ?? "any";
	const resolvedExecutor: TaskExecutor = phase.executor ?? planExecutor;

	return {
		id: phase.id,
		title: phase.title,
		description: phase.description,
		order: phase.order,
		dependsOn: [...phase.dependsOn],
		executor: phase.executor ?? "any",
		resolvedExecutor,
		frozen: phase.frozen ?? false,
		acceptanceCriteria: [...(phase.acceptanceCriteria ?? [])],
		taskCounts: counts,
		totalTasks: tasksInPhase.length,
		annotations: [...phase.annotations],
	};
}

/** Append acceptance criteria to a phase. Rejects if the phase is frozen. */
export function addPhaseAcceptanceCriteria(
	graph: PlanGraph,
	phaseId: string,
	criteria: string[],
): PlanGraph {
	if (phaseId === ROOT_PHASE_ID) {
		throw new Error(`Cannot add acceptance criteria to implicit '${ROOT_PHASE_ID}' phase.`);
	}
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const phase = existing[idx];
	if (phase.frozen) {
		throw new Error(`Phase ${phaseId} is frozen; unfreeze before adding acceptance criteria.`);
	}
	const next: Phase = {
		...phase,
		acceptanceCriteria: [...(phase.acceptanceCriteria ?? []), ...criteria],
	};
	const nextPhases = [...existing];
	nextPhases[idx] = next;
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

/** Freeze a phase. Rejects on the implicit root phase. */
export function freezePhase(graph: PlanGraph, phaseId: string): PlanGraph {
	if (phaseId === ROOT_PHASE_ID) {
		throw new Error(`Cannot freeze implicit '${ROOT_PHASE_ID}' phase.`);
	}
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const next: Phase = { ...existing[idx], frozen: true };
	const nextPhases = [...existing];
	nextPhases[idx] = next;
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

export function unfreezePhase(graph: PlanGraph, phaseId: string): PlanGraph {
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const next: Phase = { ...existing[idx], frozen: false };
	const nextPhases = [...existing];
	nextPhases[idx] = next;
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

/** Append an annotation to a phase. */
export function addPhaseAnnotation(
	graph: PlanGraph,
	phaseId: string,
	text: string,
	category?: AnnotationCategory,
): PlanGraph {
	if (phaseId === ROOT_PHASE_ID) {
		throw new Error(`Cannot annotate implicit '${ROOT_PHASE_ID}' phase.`);
	}
	if (category && !ANNOTATION_CATEGORIES.includes(category)) {
		throw new Error(`Unknown annotation category: ${category}. Valid: ${ANNOTATION_CATEGORIES.join(", ")}.`);
	}
	const existing = graph.phases ?? [];
	const idx = existing.findIndex((p) => p.id === phaseId);
	if (idx === -1) throw new Error(`Phase not found: ${phaseId}`);
	const annotation: PhaseAnnotation = { timestamp: Date.now(), text, ...(category ? { category } : {}) };
	const next: Phase = { ...existing[idx], annotations: [...existing[idx].annotations, annotation] };
	const nextPhases = [...existing];
	nextPhases[idx] = next;
	return { ...graph, phases: nextPhases, updatedAt: Date.now() };
}

// ─── Plan-level freeze (P2.4) ─────────────────────────────────────────

/**
 * Set `plan.frozen = true`. Idempotent. Emitted from the first `start` call
 * when the plan has never been frozen. Distinct from per-task freeze.
 */
export function freezePlan(graph: PlanGraph): PlanGraph {
	if (graph.frozen) return graph;
	return { ...graph, frozen: true, updatedAt: Date.now() };
}

// ─── scratchDir helpers (P2.6) ────────────────────────────────────────

/**
 * Compute the default scratchDir path for a plan. The caller controls
 * `plansRoot`; extensions supply `piCtx.dataDir` or similar.
 */
export function defaultScratchDir(planName: string, plansRoot: string): string {
	// Path joining without importing node:path here (this file stays fs-agnostic).
	const trimmed = plansRoot.endsWith("/") ? plansRoot.slice(0, -1) : plansRoot;
	return `${trimmed}/${planName}/scratch`;
}

/**
 * Expand the `{scratchDir}` template variable in a string. Non-matching input
 * is returned unchanged. Only expands when `scratchDir` is set; otherwise the
 * template survives so `plan_tasks get` output signals "unresolved".
 */
export function expandScratchDirTemplate(input: string, scratchDir: string | undefined): string {
	if (!scratchDir) return input;
	return input.replace(/\{scratchDir\}/g, scratchDir);
}

/**
 * Convenience: expand `{scratchDir}` across all string values in a
 * `ResolvedTaskFields` snapshot. Returns a new object.
 */
export function expandScratchDirInResolved(
	resolved: ResolvedTaskFields,
	scratchDir: string | undefined,
): ResolvedTaskFields {
	if (!scratchDir) return resolved;
	const mapStr = (s: string) => expandScratchDirTemplate(s, scratchDir);
	return {
		executor: resolved.executor,
		parallelGroup: resolved.parallelGroup,
		referenceSkills: resolved.referenceSkills.map(mapStr),
		referenceFiles: resolved.referenceFiles.map(mapStr),
		constraints: resolved.constraints.map(mapStr),
		nonGoals: resolved.nonGoals.map(mapStr),
		acceptanceCriteria: resolved.acceptanceCriteria.map(mapStr),
	};
}

// ─── Divergence enforcement helpers (P2.5) ────────────────────────────

export interface DivergenceInput {
	taskId: string;
	divergence?: string;
}

/**
 * Given a set of task IDs targeted by `complete` or `bulk-complete`, return
 * the IDs whose current status is NOT `in-progress`. These IDs require an
 * explicit `divergence` string.
 */
export function tasksRequiringDivergence(graph: PlanGraph, taskIds: string[]): string[] {
	const byId = new Map(graph.tasks.map((t) => [t.id, t] as const));
	return taskIds.filter((id) => {
		const task = byId.get(id);
		if (!task) return false; // caller handles "unknown task"
		return task.status !== "in-progress";
	});
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
	if (graph.frozen) lines.push("Plan: 🧊 frozen");
	if (graph.scratchDir) lines.push(`scratchDir: ${graph.scratchDir}`);

	const hasPhases = graph.phases && graph.phases.length > 0;
	const sortedTasks = [...resolved].sort((a, b) => a.order - b.order);

	if (hasPhases) {
		const orderedPhases = [...graph.phases!].sort((a, b) => a.order - b.order);
		const rootTasks = sortedTasks.filter((t) => !t.phaseId);
		lines.push("");
		for (const phase of orderedPhases) {
			const phaseTasks = sortedTasks.filter((t) => t.phaseId === phase.id);
			let phaseDone = 0;
			for (const t of phaseTasks) if (t.status === "done") phaseDone++;
			const phaseFrozen = phase.frozen ? " 🧊" : "";
			const phaseExec = phase.executor ? ` [executor: ${phase.executor}]` : "";
			const phaseDeps = phase.dependsOn.length > 0 ? ` [depends: ${phase.dependsOn.join(", ")}]` : "";
			lines.push(`▸ Phase ${phase.id}: ${phase.title} — ${phaseDone}/${phaseTasks.length} done${phaseFrozen}${phaseExec}${phaseDeps}`);
			if (phase.description) lines.push(`  ${phase.description}`);
			if (phase.acceptanceCriteria?.length) {
				lines.push(`  Phase AC${phase.frozen ? " (frozen)" : ""}:`);
				for (const ac of phase.acceptanceCriteria) lines.push(`    • ${ac}`);
			}
			if (phase.annotations.length) {
				for (const a of phase.annotations) {
					const tag = a.category ? ` [${a.category}]` : "";
					lines.push(`  📝${tag} ${a.text}`);
				}
			}
			for (const task of phaseTasks) lines.push(...renderTaskLines(task));
			lines.push("");
		}
		if (rootTasks.length > 0) {
			let rootDone = 0;
			for (const t of rootTasks) if (t.status === "done") rootDone++;
			lines.push(`▸ Phase _root (implicit) — ${rootDone}/${rootTasks.length} done`);
			for (const task of rootTasks) lines.push(...renderTaskLines(task));
			lines.push("");
		}
	} else {
		lines.push("");
		for (const task of sortedTasks) lines.push(...renderTaskLines(task));
	}

	return lines.join("\n").replace(/\n+$/, "");
}

function renderTaskLines(task: PlanTask): string[] {
	const lines: string[] = [];
	const icon = STATUS_ICONS[task.status] ?? "?";
	const deps = task.dependsOn.length > 0 ? ` [depends: ${task.dependsOn.join(", ")}]` : "";
	const parallel = task.parallelGroup ? ` [parallel: ${task.parallelGroup}]` : "";
	const frozen = task.frozen ? " 🧊" : "";
	const files = task.files?.length ? ` files: ${task.files.join(", ")}` : "";
	const executor = task.executor ? ` [executor: ${task.executor}]` : "";
	const phase = task.phaseId ? ` [phase: ${task.phaseId}]` : "";
	const divergenceBadge = task.annotations.some((a) => a.category === "divergence") ? " ⚠️ divergence" : "";
	const blockerBadge = task.annotations.some((a) => a.category === "blocker") ? " 🛑 blocker" : "";
	lines.push(`${icon} ${task.id}: ${task.title} (${task.status})${frozen}${deps}${parallel}${executor}${phase}${divergenceBadge}${blockerBadge}`);
	if (task.description) lines.push(`   ${task.description}`);
	if (files) lines.push(`  ${files}`);
	if (task.tddNotes) lines.push(`   TDD: ${task.tddNotes}`);
	if (task.acceptanceCriteria?.length) {
		lines.push(`   Acceptance Criteria${task.frozen ? " (frozen)" : ""}:`);
		for (const ac of task.acceptanceCriteria) lines.push(`     • ${ac}`);
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
	if (task.constraints?.length) lines.push(`   Constraints: ${task.constraints.join("; ")}`);
	if (task.nonGoals?.length) lines.push(`   Non-goals: ${task.nonGoals.join("; ")}`);
	for (const sub of task.subtasks) {
		const subIcon = STATUS_ICONS[sub.status] ?? "?";
		lines.push(`   ${subIcon} ${sub.id}: ${sub.title} (${sub.status})`);
		if (sub.tddBehavior) lines.push(`      test: ${sub.tddBehavior}`);
	}
	if (task.annotations.length > 0) {
		for (const ann of task.annotations) {
			const time = new Date(ann.timestamp).toISOString().slice(11, 19);
			const tag = ann.category ? ` [${ann.category}]` : "";
			lines.push(`   📝 [${time}]${tag} ${ann.text}`);
		}
	}
	return lines;
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
