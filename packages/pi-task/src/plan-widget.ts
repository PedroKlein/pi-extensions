/**
 * Plan widget — TUI for browsing plans, tasks, viewing status/dependencies, and annotating.
 *
 * Two views:
 * - Plan list: shows all plans with progress, active marker. Switch/archive plans.
 * - Task view: shows tasks for the active plan with details, annotations, diff.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type PlanGraph,
	type PlanTask,
	type PlanDiffEntry,
	resolveTaskStatuses,
	computePlanDiff,
	getTaskCounts,
} from "./plan.js";
import { type PlanSummary } from "./plan-persistence.js";

function pad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return text;
	return text + " ".repeat(width - vis);
}

const STATUS_ICONS: Record<string, string> = {
	pending: "⏳",
	ready: "🔓",
	"in-progress": "🔧",
	done: "✅",
	skipped: "⏭",
	blocked: "🔒",
};

const PLAN_STATUS_ICONS: Record<string, string> = {
	active: "📋",
	archived: "📦",
	unknown: "❓",
};

export interface PlanWidgetResult {
	action: "annotate" | "switch-plan" | "archive-plan" | "unarchive-plan" | "close";
	taskId?: string;
	annotation?: string;
	planName?: string;
}

export interface PlanWidgetInput {
	/** Current active plan graph (may be null if no active plan). */
	graph: PlanGraph | null;
	/** Summaries of all plans on disk. */
	planSummaries: PlanSummary[];
	/** Which view to start in. Defaults to "tasks" if graph exists, "plans" otherwise. */
	initialView?: "tasks" | "plans";
}

export async function showPlanWidget(
	ctx: ExtensionContext,
	input: PlanWidgetInput,
): Promise<PlanWidgetResult | null> {
	const { graph, planSummaries } = input;
	const initialView = input.initialView ?? (graph ? "tasks" : "plans");

	// Task view data (only if we have a graph)
	const resolved = graph ? resolveTaskStatuses(graph.tasks) : [];
	const sorted = [...resolved].sort((a, b) => a.order - b.order);
	const diff = graph ? computePlanDiff(graph) : [];
	const diffMap = new Map<string, PlanDiffEntry>(diff.map((d) => [d.taskId, d]));

	return ctx.ui.custom<PlanWidgetResult | null>(
		(tui, theme, _kb, done) => {
			// Shared state
			let viewMode: "plans" | "tasks" | "diff" = initialView;
			let cachedLines: string[] | undefined;

			// Plan list state
			let planIndex = Math.max(0, planSummaries.findIndex((p) => p.isActive));
			let confirmingArchive = false;

			// Task view state
			let taskIndex = 0;
			let subtaskIndex = -1; // -1 = task level, >=0 = subtask
			let showingAnnotateInput = false;
			let annotateBuffer = "";

			function selectedTask(): PlanTask {
				return sorted[taskIndex] ?? sorted[0];
			}

			function selectedPlan(): PlanSummary | undefined {
				return planSummaries[planIndex];
			}

			function invalidate(): void {
				cachedLines = undefined;
			}

			// ─── Row helpers ────────────────────────────────────────

			function row(content: string, contentW: number): string {
				const fitted =
					visibleWidth(content) > contentW
						? truncateToWidth(content, contentW)
						: pad(content, contentW);
				return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
			}

			function emptyRow(contentW: number): string {
				return row("", contentW);
			}

			// ─── Input handling ─────────────────────────────────────

			function handleInput(data: string): void {
				if (showingAnnotateInput) {
					handleAnnotateInput(data);
					return;
				}

				if (confirmingArchive) {
					handleArchiveConfirm(data);
					return;
				}

				if (viewMode === "plans") {
					handlePlanListInput(data);
				} else {
					handleTaskViewInput(data);
				}
			}

			function handlePlanListInput(data: string): void {
				if (matchesKey(data, "escape") || data === "q") {
					done(null);
					return;
				}

				if (matchesKey(data, "up") || data === "k") {
					if (planIndex > 0) planIndex--;
				} else if (matchesKey(data, "down") || data === "j") {
					if (planIndex < planSummaries.length - 1) planIndex++;
				} else if (matchesKey(data, "enter")) {
					const plan = selectedPlan();
					if (plan && plan.status !== "archived") {
						done({ action: "switch-plan", planName: plan.name });
						return;
					}
				} else if (data === "x") {
					const plan = selectedPlan();
					if (plan && plan.status !== "archived") {
						confirmingArchive = true;
					}
				} else if (data === "u") {
					const plan = selectedPlan();
					if (plan && plan.status === "archived") {
						done({ action: "unarchive-plan", planName: plan.name });
						return;
					}
				} else if (data === "t" && graph) {
					// Switch to task view (only if there's an active graph)
					viewMode = "tasks";
				}

				invalidate();
				tui.requestRender();
			}

			function handleTaskViewInput(data: string): void {
				if (matchesKey(data, "escape") || data === "q") {
					done(null);
					return;
				}

				if (data === "p") {
					viewMode = "plans";
					invalidate();
					tui.requestRender();
					return;
				}

				if (data === "d") {
					viewMode = viewMode === "diff" ? "tasks" : "diff";
				} else if (matchesKey(data, "up") || data === "k") {
					if (subtaskIndex > 0) {
						subtaskIndex--;
					} else if (subtaskIndex === 0) {
						subtaskIndex = -1;
					} else if (taskIndex > 0) {
						taskIndex--;
						subtaskIndex = -1;
					}
				} else if (matchesKey(data, "down") || data === "j") {
					const task = selectedTask();
					if (subtaskIndex === -1 && task.subtasks.length > 0) {
						subtaskIndex = 0;
					} else if (subtaskIndex >= 0 && subtaskIndex < task.subtasks.length - 1) {
						subtaskIndex++;
					} else if (taskIndex < sorted.length - 1) {
						taskIndex++;
						subtaskIndex = -1;
					}
				} else if (data === "a") {
					showingAnnotateInput = true;
					annotateBuffer = "";
				}

				invalidate();
				tui.requestRender();
			}

			function handleAnnotateInput(data: string): void {
				if (matchesKey(data, "enter")) {
					if (annotateBuffer.trim()) {
						done({
							action: "annotate",
							taskId: selectedTask().id,
							annotation: annotateBuffer.trim(),
						});
					}
					showingAnnotateInput = false;
					annotateBuffer = "";
				} else if (matchesKey(data, "escape")) {
					showingAnnotateInput = false;
					annotateBuffer = "";
				} else if (matchesKey(data, "backspace")) {
					annotateBuffer = annotateBuffer.slice(0, -1);
				} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
					annotateBuffer += data;
				}

				invalidate();
				tui.requestRender();
			}

			function handleArchiveConfirm(data: string): void {
				if (data === "y" || data === "Y") {
					const plan = selectedPlan();
					if (plan) {
						done({ action: "archive-plan", planName: plan.name });
						return;
					}
				}
				confirmingArchive = false;
				invalidate();
				tui.requestRender();
			}

			// ─── Plan list rendering ────────────────────────────────

			function renderPlanList(contentW: number): string[] {
				const lines: string[] = [];

				if (planSummaries.length === 0) {
					lines.push(row(theme.fg("dim", "No plans found. Create one with plan_tasks tool."), contentW));
					return lines;
				}

				lines.push(row(theme.fg("muted", `${planSummaries.length} plan(s)`), contentW));
				lines.push(emptyRow(contentW));

				for (let i = 0; i < planSummaries.length; i++) {
					const plan = planSummaries[i];
					const selected = i === planIndex;
					const icon = PLAN_STATUS_ICONS[plan.status] ?? "❓";
					const marker = selected ? theme.fg("accent", "▸") : " ";
					const active = plan.isActive ? theme.fg("accent", " ★ active") : "";
					const progress = plan.totalTasks > 0
						? theme.fg("dim", ` (${plan.doneTasks}/${plan.totalTasks} done)`)
						: theme.fg("dim", " (empty)");
					const archived = plan.status === "archived" ? theme.fg("dim", " [archived]") : "";

					const line = `${marker} ${icon} ${plan.name}${progress}${active}${archived}`;
					lines.push(row(selected ? theme.fg("accent", theme.bold(line)) : line, contentW));
				}

				if (confirmingArchive) {
					const plan = selectedPlan();
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("warning", `Archive "${plan?.name}"? y/n`), contentW));
				}

				return lines;
			}

			// ─── Task view rendering ────────────────────────────────

			function renderTasks(contentW: number): string[] {
				const lines: string[] = [];

				if (!graph || sorted.length === 0) {
					lines.push(row(theme.fg("dim", "No tasks. Press 'p' to view plans."), contentW));
					return lines;
				}

				const counts = getTaskCounts(graph);
				lines.push(
					row(
						theme.fg("muted", `Tasks: ${counts.done}/${counts.total} done | Ready: ${counts.ready} | Blocked: ${counts.blocked}`),
						contentW,
					),
				);
				if (graph.sourceCheckpoint) {
					lines.push(row(theme.fg("dim", `Source: ${graph.sourceCheckpoint}`), contentW));
				}
				lines.push(emptyRow(contentW));

				for (let i = 0; i < sorted.length; i++) {
					const task = sorted[i];
					const selected = i === taskIndex && subtaskIndex === -1;
					const icon = STATUS_ICONS[task.status] ?? "?";
					const marker = selected ? theme.fg("accent", "▸") : " ";
					const deps = task.dependsOn.length > 0 ? theme.fg("dim", ` [→ ${task.dependsOn.join(", ")}]`) : "";
					const diffEntry = diffMap.get(task.id);
					const diffBadge = diffEntry
						? theme.fg(diffEntry.kind === "added" ? "success" : diffEntry.kind === "removed" ? "error" : "warning", ` [${diffEntry.kind}]`)
						: "";
					const active = graph.activeTaskId === task.id ? theme.fg("accent", " ★") : "";

					const line = `${marker} ${icon} ${task.id}: ${task.title}${deps}${diffBadge}${active}`;
					lines.push(row(selected ? theme.fg("accent", theme.bold(line)) : line, contentW));

					// Show subtasks for selected task
					if (i === taskIndex) {
						for (let s = 0; s < task.subtasks.length; s++) {
							const sub = task.subtasks[s];
							const subSelected = subtaskIndex === s;
							const subIcon = STATUS_ICONS[sub.status] ?? "?";
							const subMarker = subSelected ? theme.fg("accent", "▸") : " ";
							const subLine = `${subMarker}   ${subIcon} ${sub.id}: ${sub.title}`;
							lines.push(row(subSelected ? theme.fg("accent", subLine) : theme.fg("dim", subLine), contentW));
						}
					}
				}

				return lines;
			}

			function renderDiff(contentW: number): string[] {
				const lines: string[] = [];
				if (diff.length === 0) {
					lines.push(row(theme.fg("dim", "No changes since last revision."), contentW));
					return lines;
				}

				lines.push(row(theme.fg("muted", `Plan Diff: ${diff.length} change(s)`), contentW));
				lines.push(emptyRow(contentW));

				for (const entry of diff) {
					const color = entry.kind === "added" ? "success" : entry.kind === "removed" ? "error" : "warning";
					const prefix = entry.kind === "added" ? "+" : entry.kind === "removed" ? "-" : "~";
					lines.push(row(theme.fg(color, `${prefix} ${entry.taskId} (${entry.kind})`), contentW));
					if (entry.changes) {
						for (const change of entry.changes) {
							lines.push(row(theme.fg("dim", `    ${change}`), contentW));
						}
					}
				}

				return lines;
			}

			function renderTaskDetail(contentW: number): string[] {
				const lines: string[] = [];
				if (!graph || sorted.length === 0) return lines;

				const task = selectedTask();

				lines.push(emptyRow(contentW));
				lines.push(row(theme.fg("muted", `── ${task.id} ──`), contentW));
				lines.push(row(theme.fg("dim", `Status: ${task.status}`), contentW));
				if (task.description) {
					const descLines = wordWrap(task.description, contentW - 4);
					for (const dl of descLines) {
						lines.push(row(theme.fg("dim", dl), contentW));
					}
				}
				if (task.files?.length) {
					lines.push(row(theme.fg("dim", `Files: ${task.files.join(", ")}`), contentW));
				}
				if (task.tddNotes) {
					lines.push(row(theme.fg("dim", `TDD: ${task.tddNotes}`), contentW));
				}
				if (task.dependsOn.length > 0) {
					lines.push(row(theme.fg("dim", `Depends: ${task.dependsOn.join(", ")}`), contentW));
				}

				// Show subtask detail if selected
				if (subtaskIndex >= 0 && subtaskIndex < task.subtasks.length) {
					const sub = task.subtasks[subtaskIndex];
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("muted", `  Sub: ${sub.id}`), contentW));
					if (sub.description) lines.push(row(theme.fg("dim", `  ${sub.description}`), contentW));
					if (sub.tddBehavior) lines.push(row(theme.fg("dim", `  Test: ${sub.tddBehavior}`), contentW));
				}

				// Annotations
				if (task.annotations.length > 0) {
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("muted", "Annotations:"), contentW));
					for (const ann of task.annotations.slice(-5)) {
						const time = new Date(ann.timestamp).toISOString().slice(11, 19);
						lines.push(row(theme.fg("dim", `  📝 [${time}] ${ann.text}`), contentW));
					}
				}

				return lines;
			}

			// ─── Main render ────────────────────────────────────────

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const contentW = Math.max(50, width - 4);
				const lines: string[] = [];

				// Title bar
				let titleText: string;
				if (viewMode === "plans") {
					titleText = " 📋 Plans ";
				} else if (viewMode === "diff") {
					titleText = " 📊 Plan Diff ";
				} else {
					titleText = graph ? ` 📋 ${graph.name} ` : " 📋 Plan ";
				}
				const titleLen = visibleWidth(titleText);
				const leftDash = 1;
				const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
				lines.push(
					theme.fg("accent", "╭" + "─".repeat(leftDash)) +
						theme.fg("accent", theme.bold(titleText)) +
						theme.fg("accent", "─".repeat(rightDash) + "╮"),
				);
				lines.push(emptyRow(contentW));

				// Content
				if (viewMode === "plans") {
					lines.push(...renderPlanList(contentW));
				} else if (viewMode === "diff") {
					lines.push(...renderDiff(contentW));
				} else {
					lines.push(...renderTasks(contentW));
					lines.push(...renderTaskDetail(contentW));
				}

				// Annotate input
				if (showingAnnotateInput) {
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("accent", `📝 Annotation: ${annotateBuffer}█`), contentW));
					lines.push(row(theme.fg("dim", "Enter save · Esc cancel"), contentW));
				}

				lines.push(emptyRow(contentW));

				// Footer hints
				let hints: string;
				if (showingAnnotateInput) {
					hints = "Enter save · Esc cancel";
				} else if (confirmingArchive) {
					hints = "y confirm · n cancel";
				} else if (viewMode === "plans") {
					const plan = planSummaries[planIndex];
					const isArchived = plan?.status === "archived";
					const taskHint = graph ? " · t tasks" : "";
					const actionHint = isArchived ? " · u unarchive" : " · Enter activate · x archive";
					hints = `↑↓ navigate${actionHint}${taskHint} · Esc close`;
				} else {
					hints = "↑↓ navigate · a annotate · d diff · p plans · Esc close";
				}
				lines.push(row(theme.fg("dim", hints), contentW));
				lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

				cachedLines = lines;
				return lines;
			}

			return { render, invalidate, handleInput };
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as any,
				width: "80%",
				minWidth: 70,
				maxHeight: "75%",
			},
		},
	);
}

function wordWrap(text: string, maxWidth: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line.length + word.length + 1 > maxWidth && line.length > 0) {
			lines.push(line);
			line = "";
		}
		line += (line.length > 0 ? " " : "") + word;
	}
	if (line.length > 0) lines.push(line);
	return lines.length > 0 ? lines : [""];
}
