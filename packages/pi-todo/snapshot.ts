/**
 * Startup snapshot: multi-column kanban board printed to chat.
 *
 * Columns = task types (feature, bug, chore, research, personal).
 * Only shows columns that have tasks. Color-coded by urgency.
 * Rounded box-drawing borders with accent coloring.
 * Type icons, priority dots, blocked marker, due date badges.
 * Stacked fallback for narrow terminals.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type Task,
	type TodoState,
	type TaskType,
	TASK_TYPES,
	getCounters,
	getTasksForType,
	getTaskUrgency,
	getTasksForRepoWithGlobals,
} from "./model.js";

const MAX_LINES = 18;
const MIN_COL_WIDTH = 20;
const LATERAL_MARGIN = 4;

function getTermWidth(): number {
	return process.stdout?.columns ?? 120;
}

// ── Icons ─────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<TaskType, string> = {
	feature: "🚀",
	bug: "🐛",
	chore: "🔧",
	research: "🔬",
	review: "👀",
	personal: "👤",
};

function priorityDot(priority: string, theme: Theme): string {
	switch (priority) {
		case "high":
			return theme.fg("error", "●");
		case "medium":
			return theme.fg("muted", "◦");
		case "low":
			return theme.fg("dim", "·");
		default:
			return theme.fg("dim", "·");
	}
}

function blockedMarker(task: Task, theme: Theme): string {
	if (task.status === "blocked") return theme.fg("warning", "⚠");
	return " ";
}

// ── Due date badge ────────────────────────────────────────────────────

function dueBadge(task: Task, theme: Theme): string {
	if (!task.dueDate || task.status === "done") return "";

	const now = Date.now();
	const due = new Date(task.dueDate + "T23:59:59").getTime();
	const diffMs = due - now;
	const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));

	if (diffDays < 0) {
		return theme.fg("error", `${Math.abs(diffDays)}d!`);
	} else if (diffDays === 0) {
		return theme.fg("error", "today");
	} else if (diffDays === 1) {
		return theme.fg("warning", "1d");
	} else if (diffDays <= 7) {
		return theme.fg("warning", `${diffDays}d`);
	} else {
		return theme.fg("dim", `${diffDays}d`);
	}
}

function dueBadgePlainLen(task: Task): number {
	if (!task.dueDate || task.status === "done") return 0;
	const now = Date.now();
	const due = new Date(task.dueDate + "T23:59:59").getTime();
	const diffMs = due - now;
	const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
	if (diffDays < 0) return `${Math.abs(diffDays)}d!`.length + 1;
	if (diffDays === 0) return "today".length + 1;
	return `${Math.abs(diffDays)}d`.length + 1;
}

// ── Urgency coloring ──────────────────────────────────────────────────

function colorByUrgency(title: string, task: Task, theme: Theme): string {
	const urgency = getTaskUrgency(task);
	switch (urgency) {
		case "overdue":
			return theme.fg("error", title);
		case "due-soon":
			return theme.fg("warning", title);
		case "done":
			return theme.fg("dim", title);
		case "blocked":
			return theme.fg("muted", title);
		default:
			return theme.fg("text", title);
	}
}

// ── String helpers ────────────────────────────────────────────────────

function truncStr(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 1) + "…";
}

function padStr(str: string, width: number): string {
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

function stripAnsi(str: string): string {
	// eslint-disable-next-line no-control-regex
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function centerPad(str: string, width: number): string {
	const plainLen = stripAnsi(str).length;
	const totalPad = Math.max(0, width - plainLen);
	const left = Math.floor(totalPad / 2);
	const right = totalPad - left;
	return " ".repeat(left) + str + " ".repeat(right);
}

// ── Counter helpers ───────────────────────────────────────────────────

function buildCounters(tasks: Task[], theme: Theme): { text: string; plainLen: number } {
	const c = getCounters(tasks);
	const openCount = c.open + c.overdue + c.dueSoon;
	const parts: string[] = [];
	const plainParts: string[] = [];

	parts.push(`${openCount} open`);
	plainParts.push(`${openCount} open`);

	if (c.overdue > 0) {
		parts.push(theme.fg("error", `${c.overdue} overdue`));
		plainParts.push(`${c.overdue} overdue`);
	}
	if (c.dueSoon > 0) {
		parts.push(theme.fg("warning", `${c.dueSoon} due soon`));
		plainParts.push(`${c.dueSoon} due soon`);
	}
	if (c.blocked > 0) {
		parts.push(theme.fg("muted", `${c.blocked} blocked`));
		plainParts.push(`${c.blocked} blocked`);
	}
	parts.push(theme.fg("dim", `${c.done} done`));
	plainParts.push(`${c.done} done`);

	return { text: parts.join(" · "), plainLen: plainParts.join(" · ").length };
}

// ── Main snapshot renderer ────────────────────────────────────────────

export function renderSnapshot(
	state: TodoState,
	repoId: string,
	theme: Theme
): string | null {
	const termWidth = getTermWidth();
	const tasks = getTasksForRepoWithGlobals(state.tasks, repoId);
	if (tasks.length === 0) {
		return renderEmptyBoard(termWidth, theme);
	}

	const activeTypes = TASK_TYPES.filter(
		(type) => tasks.some((t) => t.type === type && t.status !== "done")
	);

	if (activeTypes.length === 0) {
		return renderAllDone(tasks, termWidth, theme);
	}

	const typeTasks: Map<TaskType, Task[]> = new Map();
	for (const type of activeTypes) {
		typeTasks.set(type, getTasksForType(tasks, type, "active"));
	}

	// Determine column width — fill available width with lateral margins
	const numCols = activeTypes.length;
	const targetWidth = termWidth - 2 * LATERAL_MARGIN;
	const colWidth = Math.max(MIN_COL_WIDTH, Math.floor((targetWidth - numCols - 1) / numCols));
	const totalWidth = numCols * (colWidth + 1) + 1;

	// Check if multi-column fits
	if (totalWidth > targetWidth || numCols > 5) {
		return renderStacked(tasks, activeTypes, typeTasks, targetWidth, termWidth, theme);
	}

	const lines: string[] = [];
	const innerW = totalWidth - 2;

	// ── Top border with title ──
	const title = " 📋 TODO ";
	const titleFill = Math.max(1, innerW - title.length);
	lines.push(
		theme.fg("accent", "╭─") +
		theme.fg("accent", theme.bold(title)) +
		theme.fg("accent", "─".repeat(titleFill - 1) + "╮")
	);

	// ── Counter row ──
	const { text: countersText, plainLen: countersPlainLen } = buildCounters(tasks, theme);
	const counterPad = Math.max(0, innerW - countersPlainLen - 2);
	lines.push(
		theme.fg("accent", "│") + " " + countersText + " ".repeat(counterPad) + " " +
		theme.fg("accent", "│")
	);

	// ── Column labels separator ──
	const labels = activeTypes.map(
		(t) => ` ${TYPE_ICONS[t]} ${t.charAt(0).toUpperCase() + t.slice(1)} `
	);

	let colSeparator = "";
	for (let i = 0; i < numCols; i++) {
		const label = labels[i];
		const plainLen = label.length;
		const fillLen = colWidth - plainLen;
		const leftFill = Math.floor(fillLen / 2);
		const rightFill = fillLen - leftFill;
		const connector = i === 0 ? "├" : "┬";
		colSeparator +=
			theme.fg("accent", connector + "─".repeat(Math.max(0, leftFill))) +
			theme.fg("accent", theme.bold(label)) +
			theme.fg("accent", "─".repeat(Math.max(0, rightFill)));
	}
	colSeparator += theme.fg("accent", "┤");
	lines.push(colSeparator);

	// Determine max rows
	const maxTaskRows = MAX_LINES - lines.length - 3;
	const maxPerCol = Math.max(1, maxTaskRows);
	const maxColLen = Math.max(
		...activeTypes.map((t) => Math.min(typeTasks.get(t)!.length, maxPerCol))
	);
	const rowCount = Math.max(maxColLen, 1);

	// Task rows
	// Layout: │ <dot><blocked> <title> <pad> <badge> │
	// Prefix: 1(space) + 1(dot) + 1(blocked/space) + 1(space) = 4 chars
	const prefixLen = 4;

	for (let row = 0; row < rowCount; row++) {
		let line = "";
		for (let i = 0; i < numCols; i++) {
			const ct = typeTasks.get(activeTypes[i])!;
			line += theme.fg("accent", "│");
			if (row < ct.length) {
				const task = ct[row];
				const badge = dueBadge(task, theme);
				const badgeLen = dueBadgePlainLen(task);
				const titleMaxLen = Math.max(4, colWidth - prefixLen - badgeLen);
				const titleTrunc = truncStr(task.title, titleMaxLen);
				const colored = colorByUrgency(titleTrunc, task, theme);
				const padLen = Math.max(0, colWidth - prefixLen - titleTrunc.length - badgeLen);

				line += " " + priorityDot(task.priority, theme) + blockedMarker(task, theme) + " " + colored;
				line += " ".repeat(padLen);
				if (badge) line += " " + badge;
			} else {
				line += " ".repeat(colWidth);
			}
		}
		line += theme.fg("accent", "│");
		lines.push(line);
	}

	// Overflow indicators
	let hasOverflow = false;
	for (const type of activeTypes) {
		if (typeTasks.get(type)!.length > maxPerCol) {
			hasOverflow = true;
			break;
		}
	}
	if (hasOverflow) {
		let overflowLine = "";
		for (let i = 0; i < numCols; i++) {
			const ct = typeTasks.get(activeTypes[i])!;
			overflowLine += theme.fg("accent", "│");
			if (ct.length > maxPerCol) {
				const msg = `+${ct.length - maxPerCol} more`;
				overflowLine += theme.fg("dim", " " + padStr(msg, colWidth - 1));
			} else {
				overflowLine += " ".repeat(colWidth);
			}
		}
		overflowLine += theme.fg("accent", "│");
		lines.push(overflowLine);
	}

	// Bottom border
	let bottomBorder = "";
	for (let i = 0; i < numCols; i++) {
		const connector = i === 0 ? "╰" : "┴";
		bottomBorder += theme.fg("accent", connector + "─".repeat(colWidth));
	}
	bottomBorder += theme.fg("accent", "╯");
	lines.push(bottomBorder);

	// Hint
	lines.push(theme.fg("dim", '  /todo to open board · /todo "..." to add task · Ctrl+Shift+B'));

	const indent = " ".repeat(Math.max(0, Math.floor((termWidth - totalWidth) / 2)));
	return lines.map(l => indent + l).join("\n");
}

// ── Empty board ───────────────────────────────────────────────────────

function renderEmptyBoard(termWidth: number, theme: Theme): string {
	const w = 42;
	const inner = w - 2;
	const lines: string[] = [];

	lines.push(theme.fg("accent", "╭─") + theme.fg("accent", theme.bold(" 📋 TODO ")) + theme.fg("accent", "─".repeat(inner - 10) + "╮"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad("No tasks yet", inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad(theme.fg("dim", '/todo "..." to get started'), inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad(theme.fg("dim", "Ctrl+Shift+B to open board"), inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "╰") + "─".repeat(inner) + theme.fg("accent", "╯"));

	const emptyIndent = " ".repeat(Math.max(0, Math.floor((termWidth - w) / 2)));
	return lines.map(l => emptyIndent + l).join("\n");
}

// ── All done state ────────────────────────────────────────────────────

function renderAllDone(tasks: Task[], termWidth: number, theme: Theme): string {
	const w = 42;
	const inner = w - 2;
	const c = getCounters(tasks);
	const lines: string[] = [];

	lines.push(theme.fg("accent", "╭─") + theme.fg("accent", theme.bold(" 📋 TODO ")) + theme.fg("accent", "─".repeat(inner - 10) + "╮"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad("All tasks done! 🎉", inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad(theme.fg("dim", `${c.done} completed`), inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + centerPad(theme.fg("dim", '/todo "..." to add a task'), inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "│") + " ".repeat(inner) + theme.fg("accent", "│"));
	lines.push(theme.fg("accent", "╰") + "─".repeat(inner) + theme.fg("accent", "╯"));

	const doneIndent = " ".repeat(Math.max(0, Math.floor((termWidth - w) / 2)));
	return lines.map(l => doneIndent + l).join("\n");
}

// ── Stacked fallback ──────────────────────────────────────────────────

function renderStacked(
	tasks: Task[],
	types: TaskType[],
	typeTasks: Map<TaskType, Task[]>,
	boxWidth: number,
	termWidth: number,
	theme: Theme
): string {
	const innerW = boxWidth - 2;
	const lines: string[] = [];

	// Top border with title
	const title = " 📋 TODO ";
	const titleFill = Math.max(1, innerW - title.length);
	lines.push(
		theme.fg("accent", "╭─") +
		theme.fg("accent", theme.bold(title)) +
		theme.fg("accent", "─".repeat(titleFill - 1) + "╮")
	);

	// Counter row
	const { text: countersText, plainLen: countersPlainLen } = buildCounters(tasks, theme);
	const counterPad = Math.max(0, innerW - countersPlainLen - 2);
	lines.push(
		theme.fg("accent", "│") + " " + countersText + " ".repeat(counterPad) + " " +
		theme.fg("accent", "│")
	);

	// Separator
	lines.push(theme.fg("accent", "├" + "─".repeat(innerW) + "┤"));

	// Stacked content
	for (const type of types) {
		const tt = typeTasks.get(type)!;
		const icon = TYPE_ICONS[type];
		const label = type.charAt(0).toUpperCase() + type.slice(1);

		// Type header
		const typeHeader = " " + theme.fg("accent", theme.bold(`${icon} ${label}`)) + theme.fg("dim", ` (${tt.length})`);
		const typeHeaderPlainLen = 1 + `${icon} ${label}`.length + ` (${tt.length})`.length;
		const typeHeaderPad = Math.max(0, innerW - typeHeaderPlainLen);
		lines.push(
			theme.fg("accent", "│") + typeHeader + " ".repeat(typeHeaderPad) +
			theme.fg("accent", "│")
		);

		if (tt.length === 0) {
			const emptyPlainLen = 5 + "(empty)".length;
			const emptyPad = Math.max(0, innerW - emptyPlainLen);
			lines.push(
				theme.fg("accent", "│") + "     " + theme.fg("dim", "(empty)") + " ".repeat(emptyPad) +
				theme.fg("accent", "│")
			);
		}
		for (const task of tt.slice(0, 5)) {
			const pDot = priorityDot(task.priority, theme);
			const bMark = blockedMarker(task, theme);
			const badge = dueBadge(task, theme);
			const badgeLen = dueBadgePlainLen(task);
			const prefixLen = 5; // "   " + dot + mark
			const titleMaxLen = Math.max(4, innerW - prefixLen - 1 - badgeLen);
			const titleTrunc = truncStr(task.title, titleMaxLen);
			const colored = colorByUrgency(titleTrunc, task, theme);
			const usedLen = prefixLen + 1 + titleTrunc.length + badgeLen;
			const padLen = Math.max(0, innerW - usedLen);

			let taskLine = "   " + pDot + bMark + " " + colored;
			taskLine += " ".repeat(padLen);
			if (badge) taskLine += " " + badge;
			lines.push(theme.fg("accent", "│") + taskLine + theme.fg("accent", "│"));
		}
		if (tt.length > 5) {
			const moreText = `+${tt.length - 5} more`;
			const morePlainLen = 5 + moreText.length;
			const morePad = Math.max(0, innerW - morePlainLen);
			lines.push(
				theme.fg("accent", "│") + "     " + theme.fg("dim", moreText) + " ".repeat(morePad) +
				theme.fg("accent", "│")
			);
		}
	}

	// Bottom border
	lines.push(theme.fg("accent", "╰" + "─".repeat(innerW) + "╯"));

	// Hint
	lines.push(theme.fg("dim", '  /todo to open board · /todo "..." to add task · Ctrl+Shift+B'));

	const indent = " ".repeat(Math.max(0, Math.floor((termWidth - boxWidth) / 2)));
	return lines.map(l => indent + l).join("\n");
}
