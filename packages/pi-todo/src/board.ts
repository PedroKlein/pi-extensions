/**
 * Interactive TODO board — centered modal overlay with single-type view.
 *
 * h/l switch type, j/k move task selection, Enter opens details,
 * d = toggle done, x = delete, n = annotate, s = cycle filter,
 * Tab = toggle scope, Esc/q = close.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type Task,
	type TodoState,
	type StatusFilter,
	TASK_TYPES,
	STATUS_FILTERS,
	TASK_PRIORITIES,
	TASK_STATUSES,
	REVIEW_ACTIONS,
	getTasksForScope,
	getAllScopes,
	getTaskUrgency,
	getCounters,
	shortRepoName,
	getTaskRepoId,
	getNextIdForScope,
	sortTasksByUrgency,
	filterByStatus,
} from "./model.js";

interface BoardCallbacks {
	onSave: () => Promise<void>;
	onDelete: (taskId: number) => Promise<void>;
	onOpenUrl: (url: string) => Promise<void>;
	onAiSummary: (task: Task) => Promise<void>;
	onCloneReview: (task: Task) => Promise<void>;
	onInject: (task: Task) => Promise<void>;
	getRepoId: () => string;
	getAllTasks: () => Task[];
	getTasksForRepo: (repoId: string) => Task[];
}

type BoardMode = "list" | "details";

interface BoardState {
	scopeIndex: number;
	scopes: string[];
	taskIndex: number;
	statusFilter: StatusFilter;
	mode: BoardMode;
	detailFieldIndex: number;
	editing: boolean;
	editBuffer: string;
}

const DETAIL_FIELDS = ["title", "type", "priority", "status", "dueDate", "description", "note", "repo"] as const;
type DetailField = (typeof DETAIL_FIELDS)[number];

/**
 * Create and show the interactive board UI as a centered overlay modal.
 */
export async function createBoardUI(
	ctx: ExtensionContext,
	state: TodoState,
	currentRepoId: string,
	callbacks: BoardCallbacks
): Promise<void> {
	const scopes = getAllScopes(state.tasks, currentRepoId);
	const bs: BoardState = {
		scopeIndex: 0, // starts on current repo
		scopes,
		taskIndex: 0,
		statusFilter: "active",
		mode: "list",
		detailFieldIndex: 0,
		editing: false,
		editBuffer: "",
	};

	function getCurrentScope(): string {
		return bs.scopes[bs.scopeIndex];
	}

	function getCurrentTasks(): Task[] {
		const scopeTasks = getTasksForScope(state.tasks, getCurrentScope());
		return sortTasksByUrgency(filterByStatus(scopeTasks, bs.statusFilter));
	}

	function getSelectedTask(): Task | undefined {
		return getCurrentTasks()[bs.taskIndex];
	}

	function clampTaskIndex() {
		const tasks = getCurrentTasks();
		if (bs.taskIndex >= tasks.length) bs.taskIndex = Math.max(0, tasks.length - 1);
	}

	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			function invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			}

			// ── Helpers ───────────────────────────────────────────────

			function pad(s: string, len: number): string {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, len - vis));
			}

			function row(content: string, contentW: number): string {
				const fitted = visibleWidth(content) > contentW
					? truncateToWidth(content, contentW)
					: pad(content, contentW);
				return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
			}

			function emptyRow(contentW: number): string {
				return row("", contentW);
			}

			function divider(contentW: number): string {
				return row(theme.fg("borderMuted", "─".repeat(contentW)), contentW);
			}

			// ── Input ─────────────────────────────────────────────────

			function handleInput(data: string) {
				if (bs.editing) {
					handleEditInput(data);
				} else if (bs.mode === "details") {
					handleDetailsInput(data, done);
				} else {
					handleListInput(data, done);
				}
				invalidate();
				_tui.requestRender();
			}

			function handleListInput(data: string, done: (v: void) => void) {
				if (matchesKey(data, Key.left) || data === "h") {
					bs.scopeIndex = (bs.scopeIndex - 1 + bs.scopes.length) % bs.scopes.length;
					bs.taskIndex = 0;
				} else if (matchesKey(data, Key.right) || data === "l") {
					bs.scopeIndex = (bs.scopeIndex + 1) % bs.scopes.length;
					bs.taskIndex = 0;
				} else if (matchesKey(data, Key.up) || data === "k") {
					if (bs.taskIndex > 0) bs.taskIndex--;
				} else if (matchesKey(data, Key.down) || data === "j") {
					const tasks = getCurrentTasks();
					if (bs.taskIndex < tasks.length - 1) bs.taskIndex++;
				} else if (matchesKey(data, Key.enter)) {
					const task = getSelectedTask();
					if (task) {
						bs.mode = "details";
						bs.detailFieldIndex = 0;
					}
				} else if (data === "d") {
					const task = getSelectedTask();
					if (task) {
						task.status = task.status === "done" ? "open" : "done";
						task.updatedAt = Date.now();
						callbacks.onSave();
						clampTaskIndex();
					}
				} else if (data === "x") {
					const task = getSelectedTask();
					if (task) {
						callbacks.onDelete(task.id);
						clampTaskIndex();
					}
				} else if (data === "n") {
					const task = getSelectedTask();
					if (task) {
						bs.mode = "details";
						bs.detailFieldIndex = DETAIL_FIELDS.indexOf("note");
						bs.editing = true;
						bs.editBuffer = task.note ?? "";
					}
				} else if (data === "f") {
					const idx = STATUS_FILTERS.indexOf(bs.statusFilter);
					bs.statusFilter = STATUS_FILTERS[(idx + 1) % STATUS_FILTERS.length];
					bs.taskIndex = 0;
				} else if (data === "s") {
					const task = getSelectedTask();
					if (task?.type === "review" && task.prMeta) {
						done(undefined);
						callbacks.onAiSummary(task);
					}
				} else if (data === "c") {
					const task = getSelectedTask();
					if (task?.type === "review" && task.prMeta) {
						done(undefined);
						callbacks.onCloneReview(task);
					}
				} else if (data === "o") {
					const task = getSelectedTask();
					if (task?.url) {
						callbacks.onOpenUrl(task.url);
					}
				} else if (data === "i") {
					const task = getSelectedTask();
					if (task) {
						done(undefined);
						callbacks.onInject(task);
					}
				} else if (matchesKey(data, Key.escape) || data === "q") {
					done(undefined);
				}
			}

			function handleDetailsInput(data: string, done: (v: void) => void) {
				const task = getSelectedTask();
				if (!task) { bs.mode = "list"; return; }

				if (matchesKey(data, Key.escape) || data === "q") {
					bs.mode = "list";
				} else if (matchesKey(data, Key.up) || data === "k") {
					if (bs.detailFieldIndex > 0) bs.detailFieldIndex--;
				} else if (matchesKey(data, Key.down) || data === "j") {
					if (bs.detailFieldIndex < DETAIL_FIELDS.length - 1) bs.detailFieldIndex++;
				} else if (matchesKey(data, Key.enter)) {
					handleFieldEdit(task, DETAIL_FIELDS[bs.detailFieldIndex]);
				} else if (data === "o") {
					if (task.url) callbacks.onOpenUrl(task.url);
				} else if (data === "s") {
					if (task.type === "review" && task.prMeta) {
						done(undefined);
						callbacks.onAiSummary(task);
					}
				} else if (data === "c") {
					if (task.type === "review" && task.prMeta) {
						done(undefined);
						callbacks.onCloneReview(task);
					}
				} else if (data === "d") {
					task.status = task.status === "done" ? "open" : "done";
					task.updatedAt = Date.now();
					callbacks.onSave();
				}
			}

			function handleFieldEdit(task: Task, field: DetailField) {
				switch (field) {
					case "type": {
						const idx = TASK_TYPES.indexOf(task.type);
						const newType = TASK_TYPES[(idx + 1) % TASK_TYPES.length];
						task.type = newType;
						// Auto-move repo based on type
						const newScope = getTaskRepoId(newType, currentRepoId);
						if (task.repoId !== newScope) {
							task.repoId = newScope;
							// Re-number ID for the new scope
							task.id = getNextIdForScope(callbacks.getAllTasks(), newScope);
						}
						task.updatedAt = Date.now();
						callbacks.onSave();
						break;
					}
					case "priority": {
						const idx = TASK_PRIORITIES.indexOf(task.priority);
						task.priority = TASK_PRIORITIES[(idx + 1) % TASK_PRIORITIES.length];
						task.updatedAt = Date.now();
						callbacks.onSave();
						break;
					}
					case "status": {
						const idx = TASK_STATUSES.indexOf(task.status);
						task.status = TASK_STATUSES[(idx + 1) % TASK_STATUSES.length];
						task.updatedAt = Date.now();
						callbacks.onSave();
						break;
					}
					case "title":
					case "dueDate":
					case "description":
					case "note": {
						bs.editing = true;
						bs.editBuffer = (task[field] as string) ?? "";
						break;
					}
					case "repo": {
						// Read-only, do nothing
						break;
					}
				}
			}

			function handleEditInput(data: string) {
				const task = getSelectedTask();
				if (!task) { bs.editing = false; return; }

				if (matchesKey(data, Key.enter)) {
					const field = DETAIL_FIELDS[bs.detailFieldIndex];
					const value = bs.editBuffer.trim();
					if (field === "dueDate" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
						bs.editing = false;
						return;
					}
					(task as any)[field] = value || undefined;
					task.updatedAt = Date.now();
					callbacks.onSave();
					bs.editing = false;
				} else if (matchesKey(data, Key.escape)) {
					bs.editing = false;
				} else if (matchesKey(data, Key.backspace)) {
					bs.editBuffer = bs.editBuffer.slice(0, -1);
				} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
					bs.editBuffer += data;
				}
			}

			// ── Render ────────────────────────────────────────────────

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;

				const contentW = width - 4; // │ + space + content + space + │
				const lines: string[] = [];
				const tasks = getCurrentTasks();
				const scopeTasks = getTasksForScope(state.tasks, getCurrentScope());
				const counters = getCounters(scopeTasks);

				// ── Top border with title ──
				const titleText = " 📋 TODO ";
				const titleLen = visibleWidth(titleText);
				const rightDash = Math.max(1, width - 2 - titleLen - 1);
				lines.push(
					theme.fg("accent", "╭" + "─") +
					theme.fg("accent", theme.bold(titleText)) +
					theme.fg("accent", "─".repeat(rightDash) + "╮")
				);

				// ── Scope tabs ──
				let tabs = "";
				for (let i = 0; i < bs.scopes.length; i++) {
					const scope = bs.scopes[i];
					const label = shortRepoName(scope);
					const count = getTasksForScope(state.tasks, scope).filter(t => t.status !== "done").length;
					if (i > 0) tabs += "  ";
					if (i === bs.scopeIndex) {
						tabs += theme.fg("accent", theme.bold(`● ${label} (${count})`));
					} else {
						tabs += theme.fg("muted", `○ ${label} (${count})`);
					}
				}
				lines.push(row(tabs, contentW));
				lines.push(divider(contentW));

				// ── Counters ──
				const cParts: string[] = [];
				cParts.push(`${counters.open + counters.overdue + counters.dueSoon} open`);
				if (counters.overdue > 0) cParts.push(theme.fg("error", `${counters.overdue} overdue`));
				if (counters.dueSoon > 0) cParts.push(theme.fg("warning", `${counters.dueSoon} due soon`));
				if (counters.blocked > 0) cParts.push(theme.fg("muted", `${counters.blocked} blocked`));
				cParts.push(theme.fg("dim", `${counters.done} done`));
				lines.push(row(cParts.join(" · ") + "  " + theme.fg("dim", `[${bs.statusFilter}]`), contentW));
				lines.push(emptyRow(contentW));

				// ── Content ──
				if (bs.mode === "details") {
					renderDetails(lines, contentW, theme);
				} else {
					renderTaskList(lines, tasks, contentW, theme);
				}

				// ── Footer ──
				lines.push(emptyRow(contentW));
				lines.push(divider(contentW));
				if (bs.mode === "details") {
					if (bs.editing) {
						lines.push(row(theme.fg("dim", "Enter save · Esc cancel"), contentW));
					} else {
						const task = getSelectedTask();
						const hints: string[] = ["j/k navigate", "Enter edit/cycle", "d done"];
						if (task?.url) hints.push("o open");
						if (task?.type === "review" && task.prMeta) {
							hints.push("s summary", "c clone-review");
						}
						hints.push("Esc back");
						lines.push(row(theme.fg("dim", hints.join(" · ")), contentW));
					}
				} else {
					const task = getSelectedTask();
					const hints: string[] = ["h/l tab", "j/k tasks"];
					if (task) {
						hints.push("Enter details", "d done", "x del", "n note", "i inject");
						if (task.url) hints.push("o open");
						if (task.type === "review" && task.prMeta) {
							hints.push("s summary", "c clone-review");
						}
					}
					hints.push("f filter", "Esc close");
					lines.push(row(theme.fg("dim", hints.join(" · ")), contentW));
				}

				// ── Bottom border ──
				lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			function renderTaskList(lines: string[], tasks: Task[], contentW: number, theme: Theme) {
				if (tasks.length === 0) {
					lines.push(row(theme.fg("dim", `No tasks in ${shortRepoName(getCurrentScope())}`), contentW));
					return;
				}

				const maxVisible = 15;
				const startIdx = Math.max(0, bs.taskIndex - maxVisible + 3);
				const endIdx = Math.min(tasks.length, startIdx + maxVisible);

				for (let i = startIdx; i < endIdx; i++) {
					const task = tasks[i];
					const selected = i === bs.taskIndex;
					const urgency = getTaskUrgency(task);

					const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
					let line = `#${task.id} `;

					if (task.status === "done") line += "✓ ";
					else if (task.status === "blocked") line += "⊘ ";
					else line += "○ ";

					line += task.title;

					const meta: string[] = [];
					meta.push(task.type);
					if (task.priority !== "medium") meta.push(task.priority);
					if (task.dueDate) meta.push(`due:${task.dueDate}`);
					if (meta.length > 0) line += theme.fg("dim", ` [${meta.join(", ")}]`);

					let colored: string;
					switch (urgency) {
						case "overdue": colored = theme.fg("error", line); break;
						case "due-soon": colored = theme.fg("warning", line); break;
						case "done": colored = theme.fg("dim", line); break;
						case "blocked": colored = theme.fg("muted", line); break;
						default: colored = selected ? theme.fg("accent", line) : line;
					}

					lines.push(row(prefix + colored, contentW));
				}

				if (tasks.length > maxVisible) {
					lines.push(row(theme.fg("dim", `${tasks.length} total (scrolling)`), contentW));
				}
			}

			function renderDetails(lines: string[], contentW: number, theme: Theme) {
				const task = getSelectedTask();
				if (!task) {
					lines.push(row(theme.fg("dim", "No task selected"), contentW));
					return;
				}

				lines.push(row(theme.fg("accent", theme.bold(`Task #${task.id}`)), contentW));
				lines.push(emptyRow(contentW));

				// Standard fields
				for (let i = 0; i < DETAIL_FIELDS.length; i++) {
					const field = DETAIL_FIELDS[i];
					const selected = i === bs.detailFieldIndex;
					const prefix = selected ? theme.fg("accent", "▸ ") : "  ";

					let value = getFieldValue(task, field, theme);
					let hint = getFieldHint(field);

					if (bs.editing && selected) {
						value = theme.fg("accent", bs.editBuffer + "█");
						hint = "";
					}

					const label = theme.fg("muted", padRight(field + ":", 12));
					let line = prefix + label + " " + value;
					if (hint && !bs.editing) line += "  " + theme.fg("dim", hint);

					lines.push(row(line, contentW));
				}

				// PR metadata for review tasks
				if (task.type === "review" && task.prMeta) {
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("accent", "  ── PR Info ──"), contentW));
					const pr = task.prMeta;
					const stateColor = pr.state === "open" ? "success" : pr.state === "merged" ? "accent" : "error";
					lines.push(row("  " + theme.fg("muted", padRight("PR:", 12)) + " " + `${pr.owner}/${pr.repo} #${pr.number}`, contentW));
					lines.push(row("  " + theme.fg("muted", padRight("Author:", 12)) + " " + pr.author, contentW));
					lines.push(row("  " + theme.fg("muted", padRight("State:", 12)) + " " + theme.fg(stateColor, pr.state), contentW));
					if (pr.branch !== "unknown") {
						lines.push(row("  " + theme.fg("muted", padRight("Branch:", 12)) + " " + theme.fg("dim", pr.branch), contentW));
					}
				}

				// URL display
				if (task.url) {
					if (!task.prMeta) lines.push(emptyRow(contentW));
					lines.push(row("  " + theme.fg("muted", padRight("URL:", 12)) + " " + theme.fg("dim", truncStr(task.url, contentW - 18)), contentW));
				}

				// Actions section
				if (task.url || task.type === "review") {
					lines.push(emptyRow(contentW));
					lines.push(row(theme.fg("accent", "  ── Actions ──"), contentW));
					for (const action of REVIEW_ACTIONS) {
						lines.push(row("  " + theme.fg("accent", `[${action.key}]`) + " " + action.label, contentW));
					}
					lines.push(row("  " + theme.fg("accent", "[d]") + " Toggle done", contentW));
				}
			}

			function getFieldValue(task: Task, field: DetailField, theme: Theme): string {
				switch (field) {
					case "title": return task.title;
					case "type": return task.type;
					case "priority": return task.priority;
					case "status": return task.status;
					case "dueDate": return task.dueDate ?? theme.fg("dim", "(none)");
					case "description": return truncStr(task.description ?? "", 50) || theme.fg("dim", "(none)");
					case "note": return task.note ?? theme.fg("dim", "(none)");
					case "repo": return shortRepoName(task.repoId);
				}
			}

			function getFieldHint(field: DetailField): string {
				switch (field) {
					case "type": case "priority": case "status": return "(Enter to cycle)";
					case "title": case "dueDate": case "description": case "note": return "(Enter to edit)";
					case "repo": return "(read-only)";
					default: return "";
				}
			}

			return { render, invalidate, handleInput };
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as any,
				width: "80%",
				minWidth: 60,
				maxHeight: "75%",
			},
		},
	);
}

function truncStr(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 1) + "…";
}

function padRight(str: string, width: number): string {
	if (str.length >= width) return str;
	return str + " ".repeat(width - str.length);
}
