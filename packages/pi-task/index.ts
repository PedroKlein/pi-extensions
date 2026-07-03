/**
 * pi-task — Generic task graph manager extension.
 *
 * Provides the plan_tasks tool for creating and managing task DAGs,
 * a /task TUI for browsing plans and tasks, and plan context injection
 * into the system prompt. Knows nothing about modes, TDD, or coding
 * workflows — that's the consumer's concern.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type PlanGraph,
	type PlanTask,
	type PlanSubtask,
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
	savePreviousRevision,
	addTaskAnnotation,
	formatPlanGraphText,
	formatPlanAsChecklist,
	computePlanDiff,
} from "./lib/plan.js";
import {
	loadActivePlan,
	savePlan,
	loadPlan,
	listPlanNames,
	archivePlan as archivePlanFile,
	unarchivePlan as unarchivePlanFile,
	saveActiveRef,
	loadPlanSummaries,
	initPlanStorage,
} from "./lib/plan-persistence.js";
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

	function buildPlanContextSnippet(): string {
		if (!activePlan) return "";
		const counts = getTaskCounts(activePlan);
		const next = getNextTask(activePlan);
		const readyTasks = getReadyTasks(activePlan);
		const lines: string[] = [];
		lines.push(`\n[ACTIVE PLAN: ${activePlan.name}]`);
		lines.push(`Progress: ${counts.done}/${counts.total} done | Ready: ${counts.ready} | Blocked: ${counts.blocked}`);

		if (activePlan.tasks.length > 1) {
			const planNames = loadPlanSummaries().map((s) => s.name);
			if (planNames.length > 1) {
				lines.push(`\nMultiple plans exist: ${planNames.join(", ")}.`);
				lines.push(`Currently active: "${activePlan.name}".`);
			}
		}

		if (activePlan.sourceCheckpoint?.startsWith("spdd/")) {
			lines.push(`\n[SOURCE CANVAS: ${activePlan.sourceCheckpoint}]`);
			lines.push(`Read this file for Norms and Safeguards governing this implementation.`);
		}

		// Surface parallel groups: ready tasks in the same parallelGroup
		const parallelGroups = new Map<string, typeof readyTasks>();
		for (const task of readyTasks) {
			if (task.parallelGroup) {
				const group = parallelGroups.get(task.parallelGroup) ?? [];
				group.push(task);
				parallelGroups.set(task.parallelGroup, group);
			}
		}

		// Show parallel groups with 2+ ready tasks
		for (const [groupName, tasks] of parallelGroups) {
			if (tasks.length >= 2) {
				lines.push(`\n[PARALLEL GROUP: ${groupName}]`);
				lines.push(`${tasks.length} tasks ready for parallel execution via worker subagents:`);
				for (const task of tasks) {
					const files = task.files?.length ? ` (files: ${task.files.join(", ")})` : "";
					lines.push(`  - ${task.id}: ${task.title}${files}`);
				}
				lines.push(`Delegate each to a worker subagent with its task context, TDD notes, and relevant skills.`);
			}
		}

		if (next) {
			// If next task is part of a parallel group already shown, note it
			const inParallelGroup = next.parallelGroup && parallelGroups.has(next.parallelGroup) && (parallelGroups.get(next.parallelGroup)?.length ?? 0) >= 2;
			if (inParallelGroup) {
				lines.push(`\n[ACTIVE TASK: ${next.id} — ${next.title}] (part of parallel group "${next.parallelGroup}")`);
			} else {
				lines.push(`\n[ACTIVE TASK: ${next.id} — ${next.title}]`);
			}
			if (next.files?.length) lines.push(`Files: ${next.files.join(", ")}`);
			if (next.tddNotes) lines.push(`TDD approach: ${next.tddNotes}`);
			if (next.subtasks.length > 0) {
				const pendingSubs = next.subtasks.filter((s) => s.status !== "done" && s.status !== "skipped");
				if (pendingSubs.length > 0) {
					lines.push("Remaining sub-tasks:");
					for (const sub of pendingSubs) {
						const tdd = sub.tddBehavior ? ` — test: ${sub.tddBehavior}` : "";
						lines.push(`  - ${sub.id}: ${sub.title}${tdd}`);
					}
				}
			}
		}
		return lines.join("\n");
	}

	// ─── Plan Tasks Tool ────────────────────────────────────────────

	pi.registerTool({
		name: "plan_tasks",
		label: "Plan Tasks",
		description:
			"Create and manage implementation task graphs. Tasks form a DAG with dependencies. " +
			"Each task has a two-level hierarchy: feature-level tasks with sub-tasks. " +
			"Use in plan mode to structure work, and in build mode to track progress.",
		promptSnippet: "Manage task graphs — create, update, expand, and track implementation tasks with dependencies",
		promptGuidelines: [
			"Use plan_tasks to create structured task graphs when the user wants to plan implementation.",
			"Each task should have: id, title, description, order, dependsOn, files, tddNotes.",
			"Sub-tasks should be TDD-sized: one test + one implementation cycle.",
			"Always include tddNotes with what behaviors to test first.",
			"Set dependsOn to express execution order constraints.",
			"When multiple tasks share the same dependencies and have non-overlapping files, assign them the same parallelGroup value so build mode can delegate them to parallel worker subagents.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "update", "status", "expand", "get", "complete", "skip",
				"delete", "reorder", "update-subtask", "list-plans", "switch-plan", "archive", "unarchive", "annotate", "diff"] as const),
			planName: Type.Optional(Type.String({ description: "Plan name (for create/switch-plan/archive/unarchive)" })),
			sourceCheckpoint: Type.Optional(Type.String({ description: "Brainstorm checkpoint this plan came from" })),
			taskId: Type.Optional(Type.String({ description: "Task ID (for update/expand/get/complete/skip/delete/reorder/annotate/update-subtask)" })),
			subtaskId: Type.Optional(Type.String({ description: "Sub-task ID (for complete/skip/delete/update-subtask)" })),
			text: Type.Optional(Type.String({ description: "Annotation text (for annotate)" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.String(),
				order: Type.Number(),
				dependsOn: Type.Optional(Type.Array(Type.String())),
				files: Type.Optional(Type.Array(Type.String())),
				tddNotes: Type.Optional(Type.String()),
				parallelGroup: Type.Optional(Type.String({ description: "Group name for tasks that can execute concurrently via worker subagents" })),
				subtasks: Type.Optional(Type.Array(Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.Optional(Type.String()),
					tddBehavior: Type.Optional(Type.String()),
				}))),
			}), { description: "Tasks array (for create)" })),
			updates: Type.Optional(Type.Object({
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				dependsOn: Type.Optional(Type.Array(Type.String())),
				files: Type.Optional(Type.Array(Type.String())),
				tddNotes: Type.Optional(Type.String()),
				parallelGroup: Type.Optional(Type.String({ description: "Group name for tasks that can execute concurrently via worker subagents" })),
				order: Type.Optional(Type.Number()),
			})),
			newSubtasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.Optional(Type.String()),
				tddBehavior: Type.Optional(Type.String()),
			}), { description: "New sub-tasks to add (for expand)" })),
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
							parallelGroup: t.parallelGroup,
							subtasks: (t.subtasks ?? []).map((s: any) =>
								createPlanSubtask({ id: s.id, title: s.title, description: s.description, tddBehavior: s.tddBehavior }),
							),
						}),
					);

					const graph = createPlanGraph({
						name: params.planName, tasks: resolveTaskStatuses(tasks), sourceCheckpoint: params.sourceCheckpoint,
					});

					const errors = validatePlanGraph(graph);
					if (errors.length > 0) throw new Error(`Plan validation failed:\n${errors.map((e) => `- ${e.message}`).join("\n")}`);

					const ok = await saveAndRefreshPlan(graph);
					if (!ok) throw new Error("Failed to save plan to disk");
					if (latestCtx) updateFooterStatus(latestCtx);

					const counts = getTaskCounts(graph);
					return {
						content: [{ type: "text", text: `Plan "${graph.name}" created with ${graph.tasks.length} tasks (${counts.ready} ready).\n\n${formatPlanGraphText(graph)}` }],
						details: { plan: graph },
					};
				}

				case "status": {
					if (!activePlan) {
						return { content: [{ type: "text", text: "No active plan. Use plan_tasks with action 'create' to create one." }] };
					}
					const resolved = { ...activePlan, tasks: resolveTaskStatuses(activePlan.tasks) };
					return { content: [{ type: "text", text: formatPlanGraphText(resolved) }], details: { plan: resolved } };
				}

				case "get": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for get");
					const task = activePlan.tasks.find((t) => t.id === params.taskId);
					if (!task) throw new Error(`Task not found: ${params.taskId}`);

					const lines: string[] = [
						`Task: ${task.id} — ${task.title}`, `Status: ${task.status}`, `Description: ${task.description}`,
					];
					if (task.dependsOn.length > 0) lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
					if (task.files?.length) lines.push(`Files: ${task.files.join(", ")}`);
					if (task.tddNotes) lines.push(`TDD: ${task.tddNotes}`);
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
					return { content: [{ type: "text", text: lines.join("\n") }], details: { task } };
				}

				case "update": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for update");
					if (!params.updates) throw new Error("updates object is required for update");

					const prevGraph = savePreviousRevision(activePlan);
					const updated = updateTask(prevGraph, params.taskId, params.updates);
					const errors = validatePlanGraph(updated);
					if (errors.length > 0) throw new Error(`Update validation failed:\n${errors.map((e) => `- ${e.message}`).join("\n")}`);

					await saveAndRefreshPlan(updated);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${params.taskId} updated.` }], details: { task: updated.tasks.find((t) => t.id === params.taskId) } };
				}

				case "expand": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for expand");
					if (!params.newSubtasks || params.newSubtasks.length === 0) throw new Error("newSubtasks array is required for expand");

					const subs: PlanSubtask[] = params.newSubtasks.map((s: any) =>
						createPlanSubtask({ id: s.id, title: s.title, description: s.description, tddBehavior: s.tddBehavior }),
					);
					const prevGraph = savePreviousRevision(activePlan);
					const expanded = expandTaskSubtasks(prevGraph, params.taskId, subs);
					await saveAndRefreshPlan(expanded);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${params.taskId} expanded with ${subs.length} sub-task(s).` }] };
				}

				case "complete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for complete");

					let updated: PlanGraph;
					if (params.subtaskId) {
						updated = setSubtaskStatus(activePlan, params.taskId, params.subtaskId, "done");
					} else {
						updated = setTaskStatus(activePlan, params.taskId, "done");
					}
					await saveAndRefreshPlan(updated);
					if (latestCtx) updateFooterStatus(latestCtx);

					const label = params.subtaskId ? `Sub-task ${params.subtaskId}` : `Task ${params.taskId}`;
					const counts = getTaskCounts(updated);
					const nextReady = getReadyTasks(updated);
					return {
						content: [{
							type: "text",
							text: `✅ ${label} completed. Progress: ${counts.done}/${counts.total}.${nextReady.length > 0 ? ` Next ready: ${nextReady.map((t) => t.id).join(", ")}` : " All tasks done!"}`,
						}],
					};
				}

				case "skip": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for skip");

					let updated: PlanGraph;
					if (params.subtaskId) {
						updated = setSubtaskStatus(activePlan, params.taskId, params.subtaskId, "skipped");
					} else {
						updated = setTaskStatus(activePlan, params.taskId, "skipped");
					}
					await saveAndRefreshPlan(updated);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `⏭ ${params.subtaskId ? `Sub-task ${params.subtaskId}` : `Task ${params.taskId}`} skipped.` }] };
				}

				case "delete": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for delete");

					const prevGraph = savePreviousRevision(activePlan);
					let updated: PlanGraph;

					if (params.subtaskId) {
						// Delete subtask
						const task = prevGraph.tasks.find((t) => t.id === params.taskId);
						if (!task) throw new Error(`Task not found: ${params.taskId}`);
						updated = {
							...prevGraph,
							tasks: prevGraph.tasks.map((t) =>
								t.id === params.taskId
									? { ...t, subtasks: t.subtasks.filter((s) => s.id !== params.subtaskId) }
									: t,
							),
						};
					} else {
						// Delete task + clean up dependsOn references
						updated = {
							...prevGraph,
							tasks: prevGraph.tasks
								.filter((t) => t.id !== params.taskId)
								.map((t) => ({
									...t,
									dependsOn: t.dependsOn.filter((d) => d !== params.taskId),
								})),
						};
					}

					await saveAndRefreshPlan(updated);
					if (latestCtx) updateFooterStatus(latestCtx);
					const label = params.subtaskId ? `Sub-task ${params.subtaskId}` : `Task ${params.taskId}`;
					return { content: [{ type: "text", text: `🗑 ${label} deleted.` }] };
				}

				case "reorder": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for reorder");
					if (!params.updates?.order && params.updates?.order !== 0) throw new Error("updates.order is required for reorder");

					const prevGraph = savePreviousRevision(activePlan);
					const updated = updateTask(prevGraph, params.taskId, { order: params.updates.order });
					await saveAndRefreshPlan(updated);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `Task ${params.taskId} reordered to position ${params.updates.order}.` }] };
				}

				case "update-subtask": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for update-subtask");
					if (!params.subtaskId) throw new Error("subtaskId is required for update-subtask");
					if (!params.updates) throw new Error("updates is required for update-subtask");

					const task = activePlan.tasks.find((t) => t.id === params.taskId);
					if (!task) throw new Error(`Task not found: ${params.taskId}`);
					const subIdx = task.subtasks.findIndex((s) => s.id === params.subtaskId);
					if (subIdx === -1) throw new Error(`Sub-task not found: ${params.subtaskId}`);

					const prevGraph = savePreviousRevision(activePlan);
					const updated: PlanGraph = {
						...prevGraph,
						tasks: prevGraph.tasks.map((t) => {
							if (t.id !== params.taskId) return t;
							return {
								...t,
								subtasks: t.subtasks.map((s) => {
									if (s.id !== params.subtaskId) return s;
									return {
										...s,
										...(params.updates?.title !== undefined && { title: params.updates.title }),
										...(params.updates?.description !== undefined && { description: params.updates.description }),
									};
								}),
							};
						}),
					};

					await saveAndRefreshPlan(updated);
					return { content: [{ type: "text", text: `Sub-task ${params.subtaskId} updated.` }] };
				}

				case "list-plans": {
					const names = await listPlanNames(pi);
					if (names.length === 0) {
						return { content: [{ type: "text", text: "No plans found." }] };
					}
					const summaries = loadPlanSummaries();
					const lines = summaries.map((s) => {
						const active = s.isActive ? " ★ active" : "";
						const progress = s.totalTasks > 0 ? ` (${s.doneTasks}/${s.totalTasks} done)` : "";
						return `- ${s.name}${progress}${active}`;
					});
					return { content: [{ type: "text", text: `Plans:\n${lines.join("\n")}` }] };
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
					return { content: [{ type: "text", text: `Switched to plan: ${params.planName}` }] };
				}

				case "archive": {
					if (!params.planName) throw new Error("planName is required for archive");
					const ok = await archivePlanFile(pi, params.planName);
					if (!ok) throw new Error(`Failed to archive plan: ${params.planName}`);
					if (activePlan?.name === params.planName) {
						activePlan = null;
					}
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `📦 Plan "${params.planName}" archived.` }] };
				}

				case "unarchive": {
					if (!params.planName) throw new Error("planName is required for unarchive");
					const ok = await unarchivePlanFile(pi, params.planName);
					if (!ok) throw new Error(`Failed to unarchive plan: ${params.planName}`);
					if (latestCtx) updateFooterStatus(latestCtx);
					return { content: [{ type: "text", text: `📂 Plan "${params.planName}" unarchived.` }] };
				}

				case "annotate": {
					if (!activePlan) throw new Error("No active plan");
					if (!params.taskId) throw new Error("taskId is required for annotate");
					if (!params.text) throw new Error("text is required for annotate");
					const updated = addTaskAnnotation(activePlan, params.taskId, params.text);
					await saveAndRefreshPlan(updated);
					return { content: [{ type: "text", text: `📝 Annotation added to ${params.taskId}.` }] };
				}

				case "diff": {
					if (!activePlan) throw new Error("No active plan");
					const diff = computePlanDiff(activePlan);
					if (diff.length === 0) {
						return { content: [{ type: "text", text: "No changes since last revision." }] };
					}
					const lines = diff.map((d) => {
						const prefix = d.kind === "added" ? "+" : d.kind === "removed" ? "-" : "~";
						const changes = d.changes ? `\n  ${d.changes.join("\n  ")}` : "";
						return `${prefix} ${d.taskId} (${d.kind})${changes}`;
					});
					return { content: [{ type: "text", text: `Plan diff:\n${lines.join("\n")}` }] };
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
						ctx.ui.notify(`Switched to plan: ${result.planName}`, "success");
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
						ctx.ui.notify(`Archived: ${result.planName}`, "success");
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
						ctx.ui.notify(`Unarchived: ${result.planName}`, "success");
					} else {
						ctx.ui.notify(`Failed to unarchive: ${result.planName}`, "error");
					}
					initialView = "plans";
					continue;
				}

				if (result.action === "annotate" && result.taskId && result.annotation && activePlan) {
					const updated = addTaskAnnotation(activePlan, result.taskId, result.annotation);
					await saveAndRefreshPlan(updated);
					ctx.ui.notify(`Annotation added to ${result.taskId}`, "success");
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
			ctx.ui.notify(`Imported ${tasks.length} task groups from ${tasksPath}`, "success");
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
			const writeResult = await pi.exec("tee", [tasksPath], { timeout: 5000, stdin: checklist });
			if (writeResult.code !== 0) { ctx.ui.notify(`Failed to write ${tasksPath}`, "error"); return; }
			ctx.ui.notify(`Exported plan to ${tasksPath}`, "success");
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

	pi.on("before_agent_start", async (event) => {
		if (!activePlan) return {};
		const snippet = buildPlanContextSnippet();
		if (!snippet) return {};
		return { systemPrompt: event.systemPrompt + "\n" + snippet };
	});

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
								ctx.ui.notify(`📦 Plan "${planName}" archived.`, "success");
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
								ctx.ui.notify(`📦 Plan "${planName}" archived.`, "success");
							}
						}
					}
				} catch {
					// User dismissed the prompt — do nothing
				}
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		completionNotified = false;
		await initPlanStorage(pi);
		activePlan = await loadActivePlan(pi);
		updateFooterStatus(ctx);
	});
}
