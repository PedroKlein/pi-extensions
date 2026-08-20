/**
 * pi-task — Generic task graph manager extension.
 *
 * Provides the plan_tasks tool for creating and managing task DAGs,
 * a /task TUI for browsing plans and tasks, and plan context injection
 * into the system prompt. Knows nothing about modes, TDD, or coding
 * workflows — that's the consumer's concern.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 */
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
import {
	type PlanGraph,
	type PlanTask,
	type PlanSubtask,
	type TaskReferences,
	createPlanGraph,
	createPlanTask,
	createPlanSubtask,
	resolveTaskStatuses,
	getReadyTasks,
	getNextTask,
	getTaskCounts,
	validatePlanGraph,
	setTaskStatus,
	setSubtaskStatus,
	expandTaskSubtasks,
	updateTask,
	addTasks,
	bulkSetTaskStatus,
	savePreviousRevision,
	addTaskAnnotation,
	formatPlanGraphText,
	formatPlanAsChecklist,
	computePlanDiff,
	freezeTask,
	freezeAllTasks,
	unfreezeTask,
	addAcceptanceCriteria,
	resolveTaskExecutor,
	resolveTaskDefaults,
	addPhase,
	updatePhase,
	deletePhase,
	getPhaseStatus,
	addPhaseAcceptanceCriteria,
	freezePhase,
	unfreezePhase,
	addPhaseAnnotation,
	freezePlan,
	tasksRequiringDivergence,
	defaultScratchDir,
	expandScratchDirInResolved,
	ANNOTATION_CATEGORIES,
	type AnnotationCategory,
	type TaskExecutor,
	type PhaseDefaults,
} from "./plan.js";
import { withKeyedMutex } from "./plan-mutex.js";
import {
	loadActivePlan,
	savePlan,
	loadPlan,
	listPlanNames,
	archivePlan as archivePlanFile,
	unarchivePlan as unarchivePlanFile,
	deletePlan as deletePlanFile,
	saveActiveRef,
	loadPlanSummaries,
	initPlanStorage,
	getPlansRootForRepo,
	ensureScratchDir,
} from "./plan-persistence.js";
import { getSpawnBudget, formatBudgetLine, scanTaggedArtifacts } from "./pi-subagents-bridge.js";
import { runVerify, type VerifyRole, VERIFY_ROLES } from "./verify.js";
import { showPlanWidget, type PlanWidgetInput } from "./plan-widget.js";

// ─── OpenSpec Parser ───────────────────────────────────────────────────────

interface OpenSpecTaskGroup {
	title: string;
	done: boolean;
	subs: { title: string; done: boolean }[];
}

function parseOpenSpecTasks(markdown: string): OpenSpecTaskGroup[] {
	const groups: OpenSpecTaskGroup[] = [];
	let currentGroup: OpenSpecTaskGroup | null = null;

	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		const sectionMatch = trimmed.match(/^##\s+\d+\.\s+(.+)/);
		if (sectionMatch) {
			if (currentGroup) groups.push(currentGroup);
			currentGroup = { title: sectionMatch[1], done: false, subs: [] };
			continue;
		}
		const itemMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(?:\d+\.\d+\s+)?(.+)/);
		if (itemMatch && currentGroup) {
			currentGroup.subs.push({ title: itemMatch[2], done: itemMatch[1].toLowerCase() === "x" });
		}
	}
	if (currentGroup) groups.push(currentGroup);
	for (const group of groups) {
		if (group.subs.length > 0 && group.subs.every((s) => s.done)) group.done = true;
	}
	return groups;
}

// ─── Deprecation notices ────────────────────────────────────────────

const warnedDeprecations = new Set<string>();

/**
 * Emit a one-time deprecation warning to stderr. Subsequent calls for the
 * same key are silent. Used for `expand` → `add-subtasks` migration.
 */
function warnDeprecated(key: string, message: string): void {
	if (warnedDeprecations.has(key)) return;
	warnedDeprecations.add(key);
	// stderr is intentional — users see it in --verbose logs; agent output is unaffected.
	process.stderr.write(`[pi-task] deprecated: ${message}\n`);
}

function warnDeprecatedExpand(): void {
	warnDeprecated(
		"action:expand",
		"the `expand` action is deprecated; use `add-subtasks` instead. Behaviour is unchanged.",
	);
}

/** Test-only: reset the deprecation-warning tracker between test cases. */
export function _resetDeprecationWarningsForTests(): void {
	warnedDeprecations.clear();
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function piTask(pi: ExtensionAPI): void {
	let activePlan: PlanGraph | null = null;
	let latestCtx: ExtensionContext | null = null;
	let completionNotified = false;

	async function loadOrRefreshPlan(): Promise<PlanGraph | null> {
		activePlan = await loadActivePlan(pi);
		return activePlan;
	}

	async function saveAndRefreshPlan(graph: PlanGraph): Promise<boolean> {
		const ok = await savePlan(pi, graph);
		if (ok) {
			activePlan = graph;
			completionNotified = false; // Reset: plan state changed, re-check completion
		}
		return ok;
	}

	/**
	 * Serialize a read-modify-write mutation against the active plan.
	 *
	 * Every mutating action MUST route through this helper. Prevents the
	 * load-mutate-save race documented in `docs/design/concurrency.md`.
	 *
	 * `compute` receives the current `activePlan` inside the critical section
	 * and returns the new graph. Validation runs before persistence — a throwing
	 * validation aborts the write and releases the lock.
	 */
	async function mutateActivePlan(
		compute: (graph: PlanGraph) => PlanGraph,
	): Promise<PlanGraph> {
		if (!activePlan) throw new Error("No active plan");
		const key = activePlan.name;
		return withKeyedMutex(key, async () => {
			if (!activePlan) throw new Error("No active plan");
			const mutated = compute(activePlan);
			const errors = validatePlanGraph(mutated);
			if (errors.length > 0) {
				throw new Error(`Validation failed:\n${errors.map((e) => `- ${e.message}`).join("\n")}`);
			}
			await saveAndRefreshPlan(mutated);
			return mutated;
		});
	}

	function updateFooterStatus(ctx: ExtensionContext): void {
		if (!activePlan) {
			pi.events.emit("pi-status:update", { id: "plan", render: null });
			return;
		}
		const counts = getTaskCounts(activePlan);
		const next = getNextTask(activePlan);
		const nextLabel = next ? ` → ${next.id}` : "";
		pi.events.emit("pi-status:register", {
			id: "plan",
			priority: 20,
			render: (t: any) => t.fg("accent", `📋 ${counts.done}/${counts.total}${nextLabel}`),
		});
	}

	function buildPlanBootstrapMessage(): string {
		if (!activePlan) return "";
		const next = getNextTask(activePlan);
		const lines = [
			`[ACTIVE PLAN: ${activePlan.name}]`,
			"This is a session-start snapshot. Use plan_tasks status/get for live state.",
		];
		if (next) lines.push(`Next: ${next.id} — ${next.title}`);
		if (activePlan.scratchDir) lines.push(`Scratch: ${activePlan.scratchDir}`);
		if (activePlan.sourceCheckpoint) {
			lines.push(`Source checkpoint: ${activePlan.sourceCheckpoint}`);
		}
		return lines.join("\n");
	}

	function hasPlanBootstrapMarker(ctx: ExtensionContext): boolean {
		if (!activePlan) return false;
		return ctx.sessionManager.getBranch().some((entry) => {
			return (
				entry.type === "custom" &&
				entry.customType === "pi-task-plan-bootstrap-marker" &&
				(entry.data as { planName?: string } | undefined)?.planName ===
					activePlan?.name
			);
		});
	}

	function injectPlanBootstrap(ctx: ExtensionContext): void {
		if (!activePlan || hasPlanBootstrapMarker(ctx)) return;
		const content = buildPlanBootstrapMessage();
		if (!content) return;
		pi.sendMessage(
			{
				customType: "pi-task-plan-bootstrap",
				content,
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
		pi.appendEntry("pi-task-plan-bootstrap-marker", {
			planName: activePlan.name,
		});
	}

	// ─── Plan Tasks Tool ────────────────────────────────────────────

	pi.registerTool({
		name: "plan_tasks",
		label: "Plan Tasks",
		description:
			"Create and manage implementation task graphs. Tasks form a DAG with dependencies. " +
			"Each task has a two-level hierarchy: feature-level tasks with sub-tasks. " +
			"Use in plan mode to structure work, and in build mode to track progress.",
		promptSnippet: "Manage task graphs — create, add, update, expand, and track implementation tasks with dependencies",
		promptGuidelines: [
			"Use plan_tasks to create and incrementally build task graphs.",
			"Lifecycle: create → add (append tasks) → start (mark in-progress) → complete/skip.",
			"Use 'add' to append new tasks to an existing plan. Use 'create' only for new plans.",
			"Use 'start' to mark a task as in-progress before working on it.",
			"Use 'add-subtasks' to add sub-tasks to a task.",
			"Use 'bulk-complete' or 'bulk-skip' with taskIds[] to finish multiple tasks at once.",
			"Each task should have: id, title, description, order, dependsOn, files, tddNotes.",
			"Sub-tasks should be TDD-sized: one test + one implementation cycle.",
			"Set dependsOn to express execution order constraints.",
			"When multiple tasks share the same dependencies and have non-overlapping files, assign them the same parallelGroup value so the runtime can safely execute them concurrently. parallelGroup is a concurrency tag; see `executor` for how to spawn.",
			"executor: five-valued cascade (task > phase > plan). any=no preference; inline=run in current agent; subagent-fresh=fresh-context subagent; subagent-fork=forked-context subagent; user=human executes.",
			"Phases: use phase-create/phase-update/phase-delete for CRUD, phase-status for progress, phase-ac to append phase-level acceptance criteria, phase-freeze/phase-unfreeze to lock, phase-annotate for scoped notes. Tasks reference a phase via `phaseId`. Absence means the implicit `_root` phase.",
			"scratchDir: every plan owns a scratch directory. Reference in task fields via `{scratchDir}` and it expands to an absolute path. Set via create.scratchDir or auto-defaulted.",
			"Use 'add-criteria' to add testable acceptance criteria. Format: 'AC: [observable behavior]. Verify: [how to check].' (Deprecated alias for `update`; kept for one release.)",
			"Use 'freeze' to lock acceptance criteria before implementation. Frozen criteria cannot be modified until 'unfreeze'. First `start` also freezes the plan implicitly.",
			"Include references per task: skills to load, files to read, repos/docs/memory for context.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "add", "update", "status", "expand", "add-subtasks", "get", "start",
				"complete", "skip", "bulk-complete", "bulk-skip",
				"delete", "reorder", "update-subtask", "list-plans", "switch-plan",
				"archive", "unarchive", "delete-plan", "annotate", "diff",
				"freeze", "unfreeze", "add-criteria",
				"phase-create", "phase-update", "phase-delete", "phase-status",
				"phase-ac", "phase-freeze", "phase-unfreeze", "phase-annotate",
				"reconcile", "verify", "phase-verify"] as const),
			planName: Type.Optional(Type.String({ description: "Plan name (for create/switch-plan/archive/unarchive/delete-plan)" })),
			sourceCheckpoint: Type.Optional(Type.String({ description: "Brainstorm checkpoint this plan came from" })),
			taskId: Type.Optional(Type.String({ description: "Task ID (for update/expand/add-subtasks/get/start/complete/skip/delete/reorder/annotate/update-subtask/freeze/unfreeze/add-criteria)" })),
			taskIds: Type.Optional(Type.Array(Type.String(), { description: "Task IDs (for bulk-complete/bulk-skip)" })),
			subtaskId: Type.Optional(Type.String({ description: "Sub-task ID (for complete/skip/delete/update-subtask)" })),
			text: Type.Optional(Type.String({ description: "Annotation text (for annotate)" })),
			criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria to add (for add-criteria, phase-ac)" })),
			verbose: Type.Optional(Type.Boolean({ description: "For `get`: also return the resolved task fields (defaults cascade applied). Response `details` gains a `resolved` snapshot alongside `task`." })),
			phaseId: Type.Optional(Type.String({ description: "Phase ID (for phase-update/delete/status/ac/freeze/unfreeze/annotate)." })),
			phase: Type.Optional(Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.Optional(Type.String()),
				order: Type.Optional(Type.Number()),
				dependsOn: Type.Optional(Type.Array(Type.String())),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				executor: Type.Optional(StringEnum(["any", "inline", "subagent-fresh", "subagent-fork", "user"] as const)),
				defaults: Type.Optional(Type.Object({
					executor: Type.Optional(StringEnum(["any", "inline", "subagent-fresh", "subagent-fork", "user"] as const)),
					parallelGroup: Type.Optional(Type.String()),
					referenceSkills: Type.Optional(Type.Array(Type.String())),
					referenceFiles: Type.Optional(Type.Array(Type.String())),
					constraints: Type.Optional(Type.Array(Type.String())),
					nonGoals: Type.Optional(Type.Array(Type.String())),
					acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				})),
			}, { description: "Phase payload (for phase-create/phase-update). For phase-update, only supplied fields are updated." })),
			category: Type.Optional(StringEnum(["note", "divergence", "blocker", "decision"] as const, { description: "Annotation category (for annotate, phase-annotate). Defaults to `note`. Runtime-emitted annotations use `divergence`." })),
			divergence: Type.Optional(Type.String({ description: "Divergence note (for complete/bulk-complete on never-started tasks). Required when the target task's status is not `in-progress`. Whitespace-only strings are rejected." })),
			scratchDir: Type.Optional(Type.String({ description: "Absolute path for the plan's scratch directory (for create). If omitted, a default under the plans root is used. Reference via `{scratchDir}` in task references and constraints." })),
			reviewers: Type.Optional(Type.Number({ description: "Reviewer count for verify/phase-verify. Integer 1–10, default 4." })),
			reviewerRoles: Type.Optional(Type.Array(Type.String(), { description: "Reviewer role subset for verify/phase-verify. Any of: completeness, correctness, safety, quality. Defaults to all four." })),
			override: Type.Optional(Type.Boolean({ description: "For verify/phase-verify: opt out of block-on-FAIL. Requires a non-empty `reason`." })),
			reason: Type.Optional(Type.String({ description: "For verify/phase-verify --override: non-empty explanation for the override. Persisted into the report." })),
			tasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.String(),
				order: Type.Number(),
				dependsOn: Type.Optional(Type.Array(Type.String())),
				files: Type.Optional(Type.Array(Type.String())),
				tddNotes: Type.Optional(Type.String()),
				parallelGroup: Type.Optional(Type.String({ description: "Concurrency-only tag: tasks sharing a group are safe to run in parallel by the runtime. No implication about execution mode or subagent count. See `executor` for spawn hints." })),
				references: Type.Optional(Type.Object({
					skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names/paths to load before starting work" })),
					files: Type.Optional(Type.Array(Type.String(), { description: "Files to read before starting" })),
					repos: Type.Optional(Type.Array(Type.String(), { description: "pi-repos references for context" })),
					docs: Type.Optional(Type.Array(Type.String(), { description: "External documentation URLs" })),
					memory: Type.Optional(Type.Array(Type.String(), { description: "Memory keys/queries to search" })),
				})),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "Testable acceptance criteria. Format: 'AC: [observable behavior]. Verify: [how to check].'" })),
				nonGoals: Type.Optional(Type.Array(Type.String(), { description: "Explicitly out of scope" })),
				constraints: Type.Optional(Type.Array(Type.String(), { description: "Known constraints or danger zones" })),
				phaseId: Type.Optional(Type.String({ description: "Phase this task belongs to. Absence means the implicit `_root` phase." })),
				executor: Type.Optional(StringEnum(["any", "inline", "subagent-fresh", "subagent-fork", "user"] as const, { description: "Executor hint. Five values, in cascade order (task > phase > plan): `any` = no preference (default); `inline` = current agent handles it (no spawn); `subagent-fresh` = spawn a fresh-context subagent (no parent history); `subagent-fork` = spawn a forked-context subagent (shares parent context); `user` = human executes, agent hands off." })),
				subtasks: Type.Optional(Type.Array(Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.Optional(Type.String()),
					tddBehavior: Type.Optional(Type.String()),
				}))),
			}), { description: "Tasks array (for create/add)" })),
			updates: Type.Optional(Type.Object({
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				dependsOn: Type.Optional(Type.Array(Type.String())),
				files: Type.Optional(Type.Array(Type.String())),
				tddNotes: Type.Optional(Type.String()),
				parallelGroup: Type.Optional(Type.String({ description: "Concurrency-only tag: tasks sharing a group are safe to run in parallel by the runtime. No implication about execution mode or subagent count. See `executor` for spawn hints." })),
				order: Type.Optional(Type.Number()),
				references: Type.Optional(Type.Object({
					skills: Type.Optional(Type.Array(Type.String())),
					files: Type.Optional(Type.Array(Type.String())),
					repos: Type.Optional(Type.Array(Type.String())),
					docs: Type.Optional(Type.Array(Type.String())),
					memory: Type.Optional(Type.Array(Type.String())),
				})),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				nonGoals: Type.Optional(Type.Array(Type.String())),
				constraints: Type.Optional(Type.Array(Type.String())),
				phaseId: Type.Optional(Type.String()),
				executor: Type.Optional(StringEnum(["any", "inline", "subagent-fresh", "subagent-fork", "user"] as const)),
			})),
			newSubtasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.Optional(Type.String()),
				tddBehavior: Type.Optional(Type.String()),
			}), { description: "New sub-tasks to add (for expand/add-subtasks)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "create": {
					if (!params.planName) throw new Error("planName is required for create");
					if (!params.tasks || params.tasks.length === 0) throw new Error("tasks array is required for create");

					const tasks: PlanTask[] = params.tasks.map((t: any) =>
						createPlanTask({
							id: t.id, title: t.title, description: t.description, order: t.order,
							dependsOn: t.dependsOn, files: t.files, tddNotes: t.tddNotes,
							parallelGroup: t.parallelGroup, references: t.references,
							acceptanceCriteria: t.acceptanceCriteria, nonGoals: t.nonGoals,
							constraints: t.constraints,
							phaseId: t.phaseId,
							executor: t.executor,
							subtasks: (t.subtasks ?? []).map((s: any) =>
								createPlanSubtask({ id: s.id, title: s.title, description: s.description, tddBehavior: s.tddBehavior }),
							),
						}),
					);

					const planName = params.planName;
					const resolvedScratchDir = params.scratchDir ?? `${getPlansRootForRepo()}/${planName}/scratch`;
					ensureScratchDir(resolvedScratchDir);

					const graph: PlanGraph = {
						...createPlanGraph({
							name: planName, tasks: resolveTaskStatuses(tasks), sourceCheckpoint: params.sourceCheckpoint,
						}),
						scratchDir: resolvedScratchDir,
					};

					const errors = validatePlanGraph(graph);
					if (errors.length > 0) throw new Error(`Plan validation failed:\n${errors.map((e) => `- ${e.message}`).join("\n")}`);

					const ok = await saveAndRefreshPlan(graph);
					if (!ok) throw new Error("Failed to save plan to disk");
					if (latestCtx) updateFooterStatus(latestCtx);

					const counts = getTaskCounts(graph);
					return {
						content: [{ type: "text", text: `Plan "${graph.name}" created with ${graph.tasks.length} tasks (${counts.ready} ready).\nscratchDir: ${resolvedScratchDir}\n\n${formatPlanGraphText(graph)}` }],
						details: { plan: graph, scratchDir: resolvedScratchDir },
					};
				}

				case "add": {
					if (!activePlan) throw new Error("No active plan. Use 'create' first.");
					if (!params.tasks || params.tasks.length === 0) throw new Error("tasks array is required for add");

					const newTasks: PlanTask[] = params.tasks.map((t: any) =>
						createPlanTask({
							id: t.id, title: t.title, description: t.description, order: t.order,
							dependsOn: t.dependsOn, files: t.files, tddNotes: t.tddNotes,
							parallelGroup: t.parallelGroup, references: t.references,
							acceptanceCriteria: t.acceptanceCriteria, nonGoals: t.nonGoals,
							constraints: t.constraints,
							phaseId: t.phaseId,
							executor: t.executor,
							subtasks: (t.subtasks ?? []).map((s: any) =>
								createPlanSubtask({ id: s.id, title: s.title, description: s.description, tddBehavior: s.tddBehavior }),
							),
						}),
					);

					const updated = await mutateActivePlan((g) => addTasks(savePreviousRevision(g), newTasks));

					if (latestCtx) updateFooterStatus(latestCtx);

					const counts = getTaskCounts(updated);
					return {
						content: [{ type: "text", text: `Added ${newTasks.length} task(s) to "${updated.name}". Total: ${counts.total} tasks (${counts.ready} ready).` }],
						details: { plan: updated },
					};
				}

				case "start": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for start");
					const taskId = params.taskId;

					// P3.3: executor-aware start gate.
					const task = activePlan.tasks.find((t) => t.id === taskId);
					if (!task) throw new Error(`Task not found: ${taskId}`);
					const resolvedExecutor = resolveTaskExecutor(activePlan, task);

					if (resolvedExecutor === "user") {
						return {
							content: [{
								type: "text",
								text: `⏸ Task ${taskId} awaits user execution (executor: user). Complete manually then call \`complete\` with a divergence note.`,
							}],
							details: {
								blocked: true,
								reason: "awaiting-user",
								taskId,
								executor: resolvedExecutor,
							},
						};
					}

					let warnBudgetProbeUnavailable = false;
					if (resolvedExecutor === "subagent-fresh" || resolvedExecutor === "subagent-fork") {
						const budget = await getSpawnBudget();
						if (typeof budget.remaining === "number" && budget.remaining <= 0) {
							return {
								content: [{
									type: "text",
									text: `🛑 Task ${taskId} blocked: subagent budget exhausted (${budget.spawned}/${budget.cap}). Options: annotate-and-downgrade-inline, escalate-to-user.`,
								}],
								details: {
									blocked: true,
									reason: "subagent-budget-exhausted",
									taskId,
									executor: resolvedExecutor,
									budget,
									escalation: { options: ["annotate-and-downgrade-inline", "escalate-to-user"] },
								},
							};
						}
						if (budget.remaining === "unknown") {
							warnBudgetProbeUnavailable = true;
						}
					}

					let implicitlyFroze = false;
					await mutateActivePlan((g) => {
						let next = g;
						if (!g.frozen) {
							next = freezePlan(next);
							implicitlyFroze = true;
						}
						next = setTaskStatus(next, taskId, "in-progress");
						if (warnBudgetProbeUnavailable) {
							next = addTaskAnnotation(next, taskId,
								`Subagent budget probe unavailable; task started under executor '${resolvedExecutor}' without capacity guarantee.`,
								"note",
							);
						}
						return next;
					});
					if (latestCtx) updateFooterStatus(latestCtx);
					if (implicitlyFroze) {
						console.warn(`[pi-task] First start: plan '${activePlan.name}' implicitly frozen. Acceptance criteria and structure are now locked. Use plan_tasks unfreeze to modify.`);
					}
					const startMsg = implicitlyFroze
						? `🔧 Task ${taskId} is now in-progress. 🧊 Plan implicitly frozen on first start.`
						: `🔧 Task ${taskId} is now in-progress.`;
					return { content: [{ type: "text", text: startMsg }], details: { implicitlyFroze, executor: resolvedExecutor, budgetProbeUnavailable: warnBudgetProbeUnavailable } };
				}

				case "bulk-complete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskIds || params.taskIds.length === 0) throw new Error("taskIds array is required for bulk-complete");
					const taskIds = params.taskIds;
					const divergence = params.divergence?.trim();

					// Enforce divergence for any un-started target.
					const needsDivergence = tasksRequiringDivergence(activePlan, taskIds);
					if (needsDivergence.length > 0 && !divergence) {
						throw new Error(
							`Divergence required: task(s) [${needsDivergence.join(", ")}] are not in-progress. ` +
								`Pass \`divergence: "<explanation>"\` to bulk-complete on un-started tasks.`,
						);
					}

					const updated = await mutateActivePlan((g) => {
						let next = bulkSetTaskStatus(g, taskIds, "done");
						// Auto-annotate every un-started target with the divergence reason.
						if (divergence) {
							for (const id of needsDivergence) {
								next = addTaskAnnotation(next, id, divergence, "divergence");
							}
						}
						return next;
					});
					if (latestCtx) updateFooterStatus(latestCtx);

					const counts = getTaskCounts(updated);
					return {
						content: [{ type: "text", text: `✅ ${taskIds.length} task(s) completed: ${taskIds.join(", ")}. Progress: ${counts.done}/${counts.total}.${needsDivergence.length > 0 ? ` Divergence recorded on ${needsDivergence.length} un-started task(s).` : ""}` }],
						details: { divergenceRecorded: needsDivergence },
					};
				}

				case "bulk-skip": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskIds || params.taskIds.length === 0) throw new Error("taskIds array is required for bulk-skip");
					const taskIds = params.taskIds;

					const updated = await mutateActivePlan((g) => bulkSetTaskStatus(g, taskIds, "skipped"));
					if (latestCtx) updateFooterStatus(latestCtx);

					const counts = getTaskCounts(updated);
					return {
						content: [{ type: "text", text: `⏭ ${taskIds.length} task(s) skipped: ${taskIds.join(", ")}. Progress: ${counts.done}/${counts.total}.` }],
						details: {},
					};
				}

				case "status": {
					if (!activePlan) {
						return { content: [{ type: "text", text: "No active plan. Use plan_tasks with action 'create' to create one." }], details: {} };
					}
					const resolved = { ...activePlan, tasks: resolveTaskStatuses(activePlan.tasks) };
					const budget = await getSpawnBudget();
					const budgetLine = formatBudgetLine(budget);
					const tagged = await scanTaggedArtifacts();
					const openIds = new Set(resolved.tasks.filter((t) => t.status !== "done" && t.status !== "skipped").map((t) => t.id));
					const matches = tagged.filter((a) => openIds.has(a.taskId));
					const parts: string[] = [formatPlanGraphText(resolved), "", budgetLine];
					if (matches.length > 0) {
						parts.push("", "Pending completions from subagent artifacts:");
						for (const m of matches) parts.push(`  • ${m.taskId} → ${m.artifactPath}${m.subagentRunId ? ` (run ${m.subagentRunId})` : ""}`);
					}
					return {
						content: [{ type: "text", text: parts.join("\n") }],
						details: { plan: resolved, budget, pendingCompletions: matches },
					};
				}

				case "get": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for get");
					const task = activePlan.tasks.find((t) => t.id === params.taskId);
					if (!task) throw new Error(`Task not found: ${params.taskId}`);

					const lines: string[] = [
						`Task: ${task.id} — ${task.title}`, `Status: ${task.status}${task.frozen ? " (frozen)" : ""}`, `Description: ${task.description}`,
					];
					if (task.dependsOn.length > 0) lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
					if (task.files?.length) lines.push(`Files: ${task.files.join(", ")}`);
					if (task.phaseId) lines.push(`Phase: ${task.phaseId}`);
					const effectiveExecutor = resolveTaskExecutor(activePlan, task);
					if (task.executor || effectiveExecutor !== "any") {
						const raw = task.executor ?? "—";
						lines.push(`Executor: ${raw} (resolved: ${effectiveExecutor})`);
					}
					if (task.tddNotes) lines.push(`TDD: ${task.tddNotes}`);
					if (task.acceptanceCriteria?.length) {
						lines.push(`Acceptance Criteria${task.frozen ? " (frozen)" : ""}:`);
						for (const ac of task.acceptanceCriteria) lines.push(`  • ${ac}`);
					}
					if (task.references) {
						const refs = task.references;
						if (refs.skills?.length) lines.push(`Skills: ${refs.skills.join(", ")}`);
						if (refs.files?.length) lines.push(`Reference files: ${refs.files.join(", ")}`);
						if (refs.repos?.length) lines.push(`Repos: ${refs.repos.join(", ")}`);
						if (refs.docs?.length) lines.push(`Docs: ${refs.docs.join(", ")}`);
						if (refs.memory?.length) lines.push(`Memory: ${refs.memory.join(", ")}`);
						if (refs.related?.length) lines.push(`Related tasks: ${refs.related.join(", ")}`);
					}
					if (task.constraints?.length) lines.push(`Constraints: ${task.constraints.join("; ")}`);
					if (task.nonGoals?.length) lines.push(`Non-goals: ${task.nonGoals.join("; ")}`);
					if (task.subtasks.length > 0) {
						lines.push("Sub-tasks:");
						for (const sub of task.subtasks) {
							const tdd = sub.tddBehavior ? ` — test: ${sub.tddBehavior}` : "";
							lines.push(`  - ${sub.id}: ${sub.title} (${sub.status})${tdd}`);
						}
					}
					if (task.annotations.length > 0) {
						lines.push("Annotations:");
						for (const ann of task.annotations) lines.push(`  📝 ${ann.text}`);
					}
					const details: Record<string, unknown> = { task };
					if (params.verbose) {
						const resolved = resolveTaskDefaults(activePlan, task);
						details.resolved = resolved;
						lines.push("", "Resolved (cascade applied):");
						lines.push(`  executor: ${resolved.executor}`);
						if (resolved.parallelGroup) lines.push(`  parallelGroup: ${resolved.parallelGroup}`);
						if (resolved.referenceSkills.length) lines.push(`  referenceSkills: ${resolved.referenceSkills.join(", ")}`);
						if (resolved.referenceFiles.length) lines.push(`  referenceFiles: ${resolved.referenceFiles.join(", ")}`);
						if (resolved.constraints.length) lines.push(`  constraints: ${resolved.constraints.join("; ")}`);
						if (resolved.nonGoals.length) lines.push(`  nonGoals: ${resolved.nonGoals.join("; ")}`);
						if (resolved.acceptanceCriteria.length) {
							lines.push("  acceptanceCriteria:");
							for (const ac of resolved.acceptanceCriteria) lines.push(`    • ${ac}`);
						}
					}
					return { content: [{ type: "text", text: lines.join("\n") }], details };
				}

				case "update": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for update");
					if (!params.updates) throw new Error("updates object is required for update");
					const taskId = params.taskId;
					const updates = params.updates as Parameters<typeof updateTask>[2];

					const updated = await mutateActivePlan((g) => updateTask(savePreviousRevision(g), taskId, updates));
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${taskId} updated.` }], details: { task: updated.tasks.find((t) => t.id === taskId) } };
				}

				case "expand":
				case "add-subtasks": {
					if (params.action === "expand") warnDeprecatedExpand();
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for add-subtasks");
					if (!params.newSubtasks || params.newSubtasks.length === 0) throw new Error("newSubtasks array is required for add-subtasks");

					const subs: PlanSubtask[] = params.newSubtasks.map((s: any) =>
						createPlanSubtask({ id: s.id, title: s.title, description: s.description, tddBehavior: s.tddBehavior }),
					);
					const taskId = params.taskId;
					await mutateActivePlan((g) => expandTaskSubtasks(savePreviousRevision(g), taskId, subs));
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${taskId} expanded with ${subs.length} sub-task(s).` }], details: {} };
				}

				case "complete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for complete");
					const taskId = params.taskId;
					const subtaskId = params.subtaskId;
					const divergence = params.divergence?.trim();

					// Divergence enforcement applies to task-level complete only (not sub-tasks).
					if (!subtaskId) {
						const needsDivergence = tasksRequiringDivergence(activePlan, [taskId]);
						if (needsDivergence.length > 0 && !divergence) {
							const task = activePlan.tasks.find((t) => t.id === taskId);
							const curStatus = task?.status ?? "unknown";
							throw new Error(
								`Divergence required: task ${taskId} is '${curStatus}', not 'in-progress'. ` +
									`Pass \`divergence: "<explanation>"\` to complete without going through start.`,
							);
						}
					}

					const updated = await mutateActivePlan((g) => {
						if (subtaskId) return setSubtaskStatus(g, taskId, subtaskId, "done");
						let next = setTaskStatus(g, taskId, "done");
						if (divergence) {
							next = addTaskAnnotation(next, taskId, divergence, "divergence");
						}
						return next;
					});
					if (latestCtx) updateFooterStatus(latestCtx);

					const label = subtaskId ? `Sub-task ${subtaskId}` : `Task ${taskId}`;
					const counts = getTaskCounts(updated);
					const nextReady = getReadyTasks(updated);
					return {
						content: [{
							type: "text",
							text: `✅ ${label} completed. Progress: ${counts.done}/${counts.total}.${nextReady.length > 0 ? ` Next ready: ${nextReady.map((t) => t.id).join(", ")}` : " All tasks done!"}`,
						}],
						details: { divergenceRecorded: divergence ? [taskId] : [] },
					};
				}

				case "skip": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for skip");
					const taskId = params.taskId;
					const subtaskId = params.subtaskId;

					await mutateActivePlan((g) => {
						if (subtaskId) return setSubtaskStatus(g, taskId, subtaskId, "skipped");
						return setTaskStatus(g, taskId, "skipped");
					});
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `⏭ ${subtaskId ? `Sub-task ${subtaskId}` : `Task ${taskId}`} skipped.` }], details: {} };
				}

				case "delete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for delete");
					const taskId = params.taskId;
					const subtaskId = params.subtaskId;

					await mutateActivePlan((g) => {
						const prevGraph = savePreviousRevision(g);
						if (subtaskId) {
							const task = prevGraph.tasks.find((t) => t.id === taskId);
							if (!task) throw new Error(`Task not found: ${taskId}`);
							return {
								...prevGraph,
								tasks: prevGraph.tasks.map((t) =>
									t.id === taskId
										? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subtaskId) }
										: t,
								),
							};
						}
						return {
							...prevGraph,
							tasks: prevGraph.tasks
								.filter((t) => t.id !== taskId)
								.map((t) => ({
									...t,
									dependsOn: t.dependsOn.filter((d) => d !== taskId),
								})),
						};
					});
					if (latestCtx) updateFooterStatus(latestCtx);
					const label = subtaskId ? `Sub-task ${subtaskId}` : `Task ${taskId}`;
					return { content: [{ type: "text", text: `🗑 ${label} deleted.` }], details: {} };
				}

				case "reorder": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for reorder");
					if (!params.updates?.order && params.updates?.order !== 0) throw new Error("updates.order is required for reorder");
					const taskId = params.taskId;
					const order = params.updates.order;

					await mutateActivePlan((g) => updateTask(savePreviousRevision(g), taskId, { order }));
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${taskId} reordered to position ${order}.` }], details: {} };
				}

				case "update-subtask": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for update-subtask");
					if (!params.subtaskId) throw new Error("subtaskId is required for update-subtask");
					if (!params.updates) throw new Error("updates is required for update-subtask");
					const taskId = params.taskId;
					const subtaskId = params.subtaskId;
					const updates = params.updates;

					await mutateActivePlan((g) => {
						const task = g.tasks.find((t) => t.id === taskId);
						if (!task) throw new Error(`Task not found: ${taskId}`);
						const subIdx = task.subtasks.findIndex((s) => s.id === subtaskId);
						if (subIdx === -1) throw new Error(`Sub-task not found: ${subtaskId}`);
						const prevGraph = savePreviousRevision(g);
						return {
							...prevGraph,
							tasks: prevGraph.tasks.map((t) => {
								if (t.id !== taskId) return t;
								return {
									...t,
									subtasks: t.subtasks.map((s) => {
										if (s.id !== subtaskId) return s;
										return {
											...s,
											...(updates.title !== undefined && { title: updates.title }),
											...(updates.description !== undefined && { description: updates.description }),
										};
									}),
								};
							}),
						};
					});
					return { content: [{ type: "text", text: `Sub-task ${subtaskId} updated.` }], details: {} };
				}

				case "list-plans": {
					const names = await listPlanNames(pi);
					if (names.length === 0) {
						return { content: [{ type: "text", text: "No plans found." }], details: {} };
					}
					const summaries = loadPlanSummaries();
					const lines = summaries.map((s) => {
						const active = s.isActive ? " ★ active" : "";
						const progress = s.totalTasks > 0 ? ` (${s.doneTasks}/${s.totalTasks} done)` : "";
						return `- ${s.name}${progress}${active}`;
					});
					return { content: [{ type: "text", text: `Plans:\n${lines.join("\n")}` }], details: {} };
				}

				case "switch-plan": {
					if (!params.planName) throw new Error("planName is required for switch-plan");
					const graph = await loadPlan(pi, params.planName);
					if (!graph) throw new Error(`Plan not found: ${params.planName}`);
					// Auto-unarchive if switching to an archived plan
					if (graph.status === "archived") {
						await unarchivePlanFile(pi, params.planName);
						graph.status = "active";
					}
					await saveActiveRef(pi, { planName: params.planName, updatedAt: Date.now() });
					activePlan = graph;
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Switched to plan: ${params.planName}` }], details: {} };
				}

				case "archive": {
					if (!params.planName) throw new Error("planName is required for archive");
					const ok = await archivePlanFile(pi, params.planName);
					if (!ok) throw new Error(`Failed to archive plan: ${params.planName}`);
					if (activePlan?.name === params.planName) {
						activePlan = null;
					}
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `📦 Plan "${params.planName}" archived.` }], details: {} };
				}

				case "unarchive": {
					if (!params.planName) throw new Error("planName is required for unarchive");
					const ok = await unarchivePlanFile(pi, params.planName);
					if (!ok) throw new Error(`Failed to unarchive plan: ${params.planName}`);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `📂 Plan "${params.planName}" unarchived.` }], details: {} };
				}

				case "delete-plan": {
					if (!params.planName) throw new Error("planName is required for delete-plan");
					const ok = await deletePlanFile(pi, params.planName);
					if (!ok) throw new Error(`Failed to delete plan: ${params.planName}`);
					if (activePlan?.name === params.planName) {
						activePlan = null;
					}
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `🗑 Plan "${params.planName}" permanently deleted.` }], details: {} };
				}

				case "annotate": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for annotate");
					if (!params.text) throw new Error("text is required for annotate");
					if (params.category && !ANNOTATION_CATEGORIES.includes(params.category as AnnotationCategory)) {
						throw new Error(`Unknown annotation category: ${params.category}. Valid: ${ANNOTATION_CATEGORIES.join(", ")}.`);
					}
					const taskId = params.taskId;
					const text = params.text;
					const category = params.category as AnnotationCategory | undefined;
					await mutateActivePlan((g) => addTaskAnnotation(g, taskId, text, category));
					return { content: [{ type: "text", text: `📝 Annotation${category ? ` [${category}]` : ""} added to ${taskId}.` }], details: {} };
				}

				case "diff": {
					if (!activePlan) throw new Error("No active plan");
					const diff = computePlanDiff(activePlan);
					if (diff.length === 0) {
						return { content: [{ type: "text", text: "No changes since last revision." }], details: {} };
					}
					const lines = diff.map((d) => {
						const prefix = d.kind === "added" ? "+" : d.kind === "removed" ? "-" : "~";
						const changes = d.changes ? `\n  ${d.changes.join("\n  ")}` : "";
						return `${prefix} ${d.taskId} (${d.kind})${changes}`;
					});
					return { content: [{ type: "text", text: `Plan diff:\n${lines.join("\n")}` }], details: {} };
				}

				case "freeze": {
					if (!activePlan) throw new Error("No active plan");
					if (params.taskId) {
						const taskId = params.taskId;
						await mutateActivePlan((g) => freezeTask(g, taskId));
						if (latestCtx) updateFooterStatus(latestCtx);
						pi.events.emit("pi-task:frozen", { taskId });
						return { content: [{ type: "text", text: `🧊 Task ${taskId} frozen. Acceptance criteria are now immutable.` }], details: {} };
					}
					let skipped: string[] = [];
					const updated = await mutateActivePlan((g) => {
						const result = freezeAllTasks(g);
						skipped = result.skipped;
						return result.graph;
					});
					if (latestCtx) updateFooterStatus(latestCtx);
					const frozenCount = updated.tasks.filter((t) => t.frozen).length;
					pi.events.emit("pi-task:frozen", { taskId: null, frozenCount });
					let msg = `🧊 ${frozenCount} task(s) frozen.`;
					if (skipped.length > 0) {
						msg += ` Skipped (no criteria): ${skipped.join(", ")}`;
					}
					return { content: [{ type: "text", text: msg }], details: {} };
				}

				case "unfreeze": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for unfreeze");
					const taskId = params.taskId;
					await mutateActivePlan((g) => unfreezeTask(g, taskId));
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `🔓 Task ${taskId} unfrozen. Acceptance criteria can be modified.` }], details: {} };
				}

				case "add-criteria": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for add-criteria");
					if (!params.criteria || params.criteria.length === 0) throw new Error("criteria array is required for add-criteria");
					if (activePlan.frozen) {
						throw new Error(`Plan '${activePlan.name}' is frozen; unfreeze the target task first or use \`update\` with a divergence annotation.`);
					}
					warnDeprecated(
						"add-criteria",
						"plan_tasks add-criteria is deprecated; call \`update\` with \`updates.acceptanceCriteria\` instead. Will be removed in a future release.",
					);
					const taskId = params.taskId;
					const criteria = params.criteria;
					const updated = await mutateActivePlan((g) => addAcceptanceCriteria(g, taskId, criteria));
					if (latestCtx) updateFooterStatus(latestCtx);
					const total = updated.tasks.find((t) => t.id === taskId)?.acceptanceCriteria?.length ?? 0;
					return { content: [{ type: "text", text: `✅ Added ${criteria.length} criterion/criteria to ${taskId}. Total: ${total}.` }], details: {} };
				}

				// ─── Phase CRUD & gates (P2.1–P2.2) ──────────────────────────────

				case "phase-create": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phase) throw new Error("phase payload is required for phase-create");
					const payload = params.phase;
					await mutateActivePlan((g) => addPhase(g, {
						id: payload.id,
						title: payload.title,
						description: payload.description,
						order: payload.order,
						dependsOn: payload.dependsOn,
						acceptanceCriteria: payload.acceptanceCriteria,
						executor: payload.executor as TaskExecutor | undefined,
						defaults: payload.defaults as PhaseDefaults | undefined,
					}));
					return { content: [{ type: "text", text: `📚 Phase ${payload.id} created.` }], details: {} };
				}

				case "phase-update": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-update");
					if (!params.phase) throw new Error("phase payload is required for phase-update");
					const phaseId = params.phaseId;
					const payload = params.phase;
					await mutateActivePlan((g) => updatePhase(g, phaseId, {
						title: payload.title,
						description: payload.description,
						order: payload.order,
						dependsOn: payload.dependsOn,
						acceptanceCriteria: payload.acceptanceCriteria,
						executor: payload.executor as TaskExecutor | undefined,
						defaults: payload.defaults as PhaseDefaults | undefined,
					}));
					return { content: [{ type: "text", text: `📚 Phase ${phaseId} updated.` }], details: {} };
				}

				case "phase-delete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-delete");
					const phaseId = params.phaseId;
					await mutateActivePlan((g) => deletePhase(g, phaseId));
					return { content: [{ type: "text", text: `🗑 Phase ${phaseId} deleted.` }], details: {} };
				}

				case "phase-status": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-status");
					const report = getPhaseStatus(activePlan, params.phaseId);
					const lines: string[] = [];
					lines.push(`Phase ${report.id} — ${report.title}`);
					if (report.description) lines.push(report.description);
					lines.push(`Order: ${report.order}${report.dependsOn.length ? ` · Depends on: ${report.dependsOn.join(", ")}` : ""}`);
					lines.push(`Executor: ${report.executor}${report.executor !== report.resolvedExecutor ? ` (resolved: ${report.resolvedExecutor})` : ""}`);
					lines.push(`Frozen: ${report.frozen ? "yes" : "no"}`);
					lines.push(`Tasks (${report.totalTasks}): pending=${report.taskCounts.pending} ready=${report.taskCounts.ready} in-progress=${report.taskCounts["in-progress"]} done=${report.taskCounts.done} skipped=${report.taskCounts.skipped} blocked=${report.taskCounts.blocked}`);
					if (report.acceptanceCriteria.length) {
						lines.push("Acceptance criteria:");
						for (const ac of report.acceptanceCriteria) lines.push(`  • ${ac}`);
					}
					if (report.annotations.length) {
						lines.push("Annotations:");
						for (const a of report.annotations) {
							const tag = a.category ? `[${a.category}] ` : "";
							lines.push(`  📝 ${tag}${a.text}`);
						}
					}
					return { content: [{ type: "text", text: lines.join("\n") }], details: { phase: report } };
				}

				case "phase-ac": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-ac");
					if (!params.criteria || params.criteria.length === 0) throw new Error("criteria array is required for phase-ac");
					const phaseId = params.phaseId;
					const criteria = params.criteria;
					await mutateActivePlan((g) => addPhaseAcceptanceCriteria(g, phaseId, criteria));
					return { content: [{ type: "text", text: `✅ Added ${criteria.length} criterion/criteria to phase ${phaseId}.` }], details: {} };
				}

				case "phase-freeze": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-freeze");
					const phaseId = params.phaseId;
					await mutateActivePlan((g) => freezePhase(g, phaseId));
					return { content: [{ type: "text", text: `🧊 Phase ${phaseId} frozen.` }], details: {} };
				}

				case "phase-unfreeze": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-unfreeze");
					const phaseId = params.phaseId;
					await mutateActivePlan((g) => unfreezePhase(g, phaseId));
					return { content: [{ type: "text", text: `🔓 Phase ${phaseId} unfrozen.` }], details: {} };
				}

				case "phase-annotate": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.phaseId) throw new Error("phaseId is required for phase-annotate");
					if (!params.text) throw new Error("text is required for phase-annotate");
					if (params.category && !ANNOTATION_CATEGORIES.includes(params.category as AnnotationCategory)) {
						throw new Error(`Unknown annotation category: ${params.category}. Valid: ${ANNOTATION_CATEGORIES.join(", ")}.`);
					}
					const phaseId = params.phaseId;
					const text = params.text;
					const category = params.category as AnnotationCategory | undefined;
					await mutateActivePlan((g) => addPhaseAnnotation(g, phaseId, text, category));
					return { content: [{ type: "text", text: `📝 Annotation added to phase ${phaseId}.` }], details: {} };
				}

				// ─── P3.5: reconcile artifacts → open-task offers ──────────────────────

				case "reconcile": {
					if (!activePlan) throw new Error("No active plan");
					const tagged = await scanTaggedArtifacts();
					const openIds = new Set(activePlan.tasks.filter((t) => t.status !== "done" && t.status !== "skipped").map((t) => t.id));
					const offers = tagged.filter((a) => openIds.has(a.taskId));
					if (offers.length === 0) {
						return {
							content: [{ type: "text", text: "No pending completions from subagent artifacts." }],
							details: { offers: [] },
						};
					}
					const lines: string[] = [`Pending completions from subagent artifacts (${offers.length}):`];
					for (const o of offers) {
						lines.push(`  • ${o.taskId} → ${o.artifactPath}${o.subagentRunId ? ` (run ${o.subagentRunId})` : ""}`);
					}
					lines.push("", "Advisory only. Use `complete` with a divergence to accept.");
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { offers },
					};
				}

				// ─── P3.6b: verify / phase-verify ──────────────────────────────────

				case "verify":
				case "phase-verify": {
					if (!activePlan) throw new Error("No active plan");
					const isPhase = params.action === "phase-verify";
					if (isPhase && !params.phaseId) throw new Error("phaseId is required for phase-verify");

					const outcome = await runVerify(activePlan, {
						reviewers: params.reviewers,
						reviewerRoles: (params.reviewerRoles as VerifyRole[] | undefined),
						override: params.override,
						reason: params.reason,
						phaseId: isPhase ? params.phaseId : undefined,
					});

					if ("unavailable" in outcome) {
						return {
							content: [{ type: "text", text: `⚠️ verify unavailable: ${outcome.reason}` }],
							details: outcome,
						};
					}

					const lines = [
						`Verify (${outcome.scope}) — verdict: **${outcome.verdict}**`,
						outcome.synthesis,
						`Report: ${outcome.artifactPath}`,
					];
					if (outcome.overrideApplied) lines.push(`Override: ${outcome.overrideApplied.reason}`);
					return {
						content: [{ type: "text", text: lines.join("\n\n") }],
						details: outcome,
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	// ─── Commands ───────────────────────────────────────────────────

	pi.registerCommand("task", {
		description: "Open task browser (plans, tasks, annotations)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/task requires interactive mode", "error");
				return;
			}

			await loadOrRefreshPlan();

			let initialView: "tasks" | "plans" | undefined;
			while (true) {
				const summaries = loadPlanSummaries();
				const input: PlanWidgetInput = { graph: activePlan, planSummaries: summaries, initialView };
				const result = await showPlanWidget(ctx, input);

				if (!result || result.action === "close") break;

				if (result.action === "switch-plan" && result.planName) {
					const graph = await loadPlan(pi, result.planName);
					if (graph) {
						// Auto-unarchive if switching to an archived plan
						if (graph.status === "archived") {
							await unarchivePlanFile(pi, result.planName);
							graph.status = "active";
						}
						await saveActiveRef(pi, { planName: result.planName, updatedAt: Date.now() });
						activePlan = graph;
						updateFooterStatus(ctx);
						ctx.ui.notify(`Switched to plan: ${result.planName}`, "info");
						initialView = "tasks";
					} else {
						ctx.ui.notify(`Failed to load plan: ${result.planName}`, "error");
						initialView = "plans";
					}
					continue;
				}

				if (result.action === "archive-plan" && result.planName) {
					const ok = await archivePlanFile(pi, result.planName);
					if (ok) {
						if (activePlan?.name === result.planName || activePlan?.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "") === result.planName) {
							activePlan = null;
						}
						updateFooterStatus(ctx);
						ctx.ui.notify(`Archived: ${result.planName}`, "info");
					} else {
						ctx.ui.notify(`Failed to archive: ${result.planName}`, "error");
					}
					initialView = "plans";
					continue;
				}

				if (result.action === "unarchive-plan" && result.planName) {
					const ok = await unarchivePlanFile(pi, result.planName);
					if (ok) {
						updateFooterStatus(ctx);
						ctx.ui.notify(`Unarchived: ${result.planName}`, "info");
					} else {
						ctx.ui.notify(`Failed to unarchive: ${result.planName}`, "error");
					}
					initialView = "plans";
					continue;
				}

				if (result.action === "annotate" && result.taskId && result.annotation && activePlan) {
					const taskId = result.taskId;
					const text = result.annotation;
					await mutateActivePlan((g) => addTaskAnnotation(g, taskId, text));
					ctx.ui.notify(`Annotation added to ${result.taskId}`, "info");
					initialView = "tasks";
					continue;
				}

				break;
			}
		},
	});

	pi.registerCommand("plan-import-openspec", {
		description: "Import tasks from OpenSpec tasks.md into the active plan",
		handler: async (args, ctx) => {
			const changeName = (args ?? "").trim();
			let tasksPath: string;
			if (changeName) {
				tasksPath = `openspec/changes/${changeName}/tasks.md`;
			} else {
				const result = await pi.exec("ls", ["-1", "openspec/changes"], { timeout: 3000 });
				if (result.code !== 0) { ctx.ui.notify("No openspec/changes directory found", "error"); return; }
				const dirs = result.stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== "archive");
				if (dirs.length === 0) { ctx.ui.notify("No active OpenSpec changes found", "info"); return; }
				if (dirs.length === 1) { tasksPath = `openspec/changes/${dirs[0]}/tasks.md`; }
				else { ctx.ui.notify(`Multiple changes found: ${dirs.join(", ")}. Use /plan-import-openspec <change-name>`, "warning"); return; }
			}

			const fileResult = await pi.exec("cat", [tasksPath], { timeout: 3000 });
			if (fileResult.code !== 0) { ctx.ui.notify(`Could not read ${tasksPath}`, "error"); return; }

			const tasks = parseOpenSpecTasks(fileResult.stdout);
			if (tasks.length === 0) { ctx.ui.notify("No tasks found in tasks.md", "warning"); return; }

			const taskList = tasks.map((t, i) => `${i + 1}. ${t.title} (${t.done ? "done" : "todo"})${t.subs.length > 0 ? "\n" + t.subs.map((s) => `   - ${s.title} (${s.done ? "done" : "todo"})`).join("\n") : ""}`).join("\n");
			pi.sendUserMessage(
				`Imported OpenSpec tasks from ${tasksPath}. Create a plan_tasks graph from these:\n\n${taskList}`,
				{ deliverAs: "followUp" as any },
			);
			ctx.ui.notify(`Imported ${tasks.length} task groups from ${tasksPath}`, "info");
		},
	});

	pi.registerCommand("plan-export-openspec", {
		description: "Export active plan to OpenSpec tasks.md format",
		handler: async (args, ctx) => {
			if (!activePlan) { ctx.ui.notify("No active plan to export", "warning"); return; }
			const changeName = (args ?? "").trim();
			if (!changeName) { ctx.ui.notify("Usage: /plan-export-openspec <change-name>", "warning"); return; }

			const checklist = formatPlanAsChecklist(activePlan);
			const tasksPath = `openspec/changes/${changeName}/tasks.md`;
			const dirResult = await pi.exec("mkdir", ["-p", `openspec/changes/${changeName}`], { timeout: 3000 });
			if (dirResult.code !== 0) { ctx.ui.notify("Failed to create OpenSpec change directory", "error"); return; }
			const writeResult = await pi.exec("sh", ["-c", `cat > ${tasksPath} << 'PI_TASK_EOF'
${checklist}
PI_TASK_EOF`], { timeout: 5000 });
			if (writeResult.code !== 0) { ctx.ui.notify(`Failed to write ${tasksPath}`, "error"); return; }
			ctx.ui.notify(`Exported plan to ${tasksPath}`, "info");
		},
	});

	pi.registerCommand("spdd-sync", {
		description: "Sync code changes back to the source REASONS Canvas",
		handler: async (args, ctx) => {
			const canvasPath = (args ?? "").trim() || activePlan?.sourceCheckpoint;
			if (!canvasPath) {
				ctx.ui.notify("No canvas path. Usage: /spdd-sync <path> or have an active plan with sourceCheckpoint", "warning");
				return;
			}
			pi.sendUserMessage(
				`Sync the REASONS Canvas at ${canvasPath} with the current implementation. ` +
				`Compare the Operations section with actual code, update any sections that diverged.`,
				{ deliverAs: "followUp" as any },
			);
		},
	});

	// ─── Events ─────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateFooterStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		// Re-read plan from disk (may have been modified by other extensions)
		activePlan = await loadActivePlan(pi);
		updateFooterStatus(ctx);

		// Plan completion detection: ask to archive when all tasks done
		if (activePlan && !completionNotified && ctx.hasUI) {
			const allDone = activePlan.tasks.length > 0 && activePlan.tasks.every(
				(t) => t.status === "done" || t.status === "skipped",
			);
			if (allDone) {
				completionNotified = true;
				const planName = activePlan.name;
				const hasCanvas = activePlan.sourceCheckpoint?.startsWith("spdd/");
				try {
					if (hasCanvas) {
						const choice = await ctx.ui.select(
							`🎉 All tasks in "${planName}" are complete! Canvas: ${activePlan.sourceCheckpoint}`,
							["Sync canvas & archive", "Archive without sync", "Keep active"],
						);
						if (choice === "Sync canvas & archive") {
							pi.sendUserMessage(
								`Sync the REASONS Canvas at ${activePlan.sourceCheckpoint} with the current implementation. ` +
								`Update Operations/Entities/Structure sections to reflect what was actually built. ` +
								`Then archive the plan "${planName}".`,
								{ deliverAs: "followUp" as any },
							);
							return;
						} else if (choice === "Archive without sync") {
							const ok = await archivePlanFile(pi, planName);
							if (ok) {
								activePlan = null;
								updateFooterStatus(ctx);
								ctx.ui.notify(`📦 Plan "${planName}" archived.`, "info");
							}
						}
					} else {
						const choice = await ctx.ui.select(
							`🎉 All tasks in "${planName}" are complete! Archive it?`,
							["Yes, archive", "No, keep active"],
						);
						if (choice === "Yes, archive") {
							const ok = await archivePlanFile(pi, planName);
							if (ok) {
								activePlan = null;
								updateFooterStatus(ctx);
								ctx.ui.notify(`📦 Plan "${planName}" archived.`, "info");
							}
						}
					}
				} catch {
					// User dismissed the prompt — do nothing
				}
			}
		}
	});

	// ─── RPC: expose plan state to other extensions via events ──────────

	pi.events.on("pi-task:rpc:request" as any, (request: any) => {
		const { requestId, method } = request || {};
		if (!requestId) return;

		let data: any = null;
		let success = false;

		try {
			switch (method) {
				case "getActivePlan": {
					if (activePlan) {
						data = { plan: activePlan };
						success = true;
					}
					break;
				}
				case "getCriteria": {
					if (activePlan) {
						const tasks = activePlan.tasks
							.filter((t: any) => t.acceptanceCriteria?.length > 0)
							.map((t: any) => ({ taskId: t.id, title: t.title, criteria: t.acceptanceCriteria, frozen: t.frozen }));
						data = { tasks };
						success = tasks.length > 0;
					}
					break;
				}
				case "freeze": {
					const taskId = request.params?.taskId;
					if (activePlan) {
						const targets = taskId
							? activePlan.tasks.filter((t: any) => t.id === taskId)
							: activePlan.tasks.filter((t: any) => t.acceptanceCriteria?.length > 0);
						for (const t of targets) (t as any).frozen = true;
						savePlan(pi, activePlan);
						data = { frozenCount: targets.length };
						success = true;
					}
					break;
				}
			}
		} catch { /* swallow */ }

		pi.events.emit(`pi-task:rpc:reply:${requestId}` as any, { requestId, success, data });
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		completionNotified = false;
		await initPlanStorage(pi);
		activePlan = await loadActivePlan(pi);
		updateFooterStatus(ctx);
		injectPlanBootstrap(ctx);
	});
}
