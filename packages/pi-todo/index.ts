/**
 * pi-todo — Terminal-first TODO/Kanban extension for Pi
 *
 * Features:
 * - Startup snapshot: multi-column board grouped by type, printed at session start
 *   (displayed visually but filtered from LLM context)
 * - Interactive board: single-type view with vim-style nav (/todo or Ctrl+Shift+B)
 * - AI capture: parse natural language into structured tasks (/todo <text>)
 * - Task preview modal with Save/Discard actions
 * - AI tool: `todo` tool for reading/writing tasks (only way todos enter LLM context)
 * - Repo-scoped tasks with auto-detection from cwd
 * - JSON persistence at ~/.pi/agent/todo/pi-todo.json
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { type Task, type PrMeta, type TodoState, GLOBAL_REPO_ID, WORK_REPO_ID, REVIEW_REPO_ID, shortRepoName, createTask, getCounters, getTasksForRepoWithGlobals, getTaskRepoId, getNextIdForScope } from "./model.js";
import { loadState, saveState, initTodoStorage, getRepoSlug } from "./persistence.js";
import { renderSnapshot } from "./snapshot.js";
import { createBoardUI } from "./board.js";
import { parseTaskWithBaml, parseTaskWithLLM, parseTaskFallback } from "./capture.js";
import { parsePrUrl, discoverGitHubToken, fetchPrMeta, fallbackPrMeta } from "./github.js";
import { showAiSummaryModal, startCloneReviewSession } from "./review.js";

export default function piTodo(pi: ExtensionAPI) {
	let state: TodoState = { tasks: [] };
	let currentRepoId = GLOBAL_REPO_ID;
	let pendingCloneReviewTaskId: number | null = null;
	let baml: any = null;

	// Capture pi-baml library when available — stays null if pi-baml is not installed
	pi.events.on('pi-baml:ready', (lib: any) => {
		baml = lib;
	});

	// ── State helpers ─────────────────────────────────────────────────────

	function getTasksForRepo(repoId: string): Task[] {
		return getTasksForRepoWithGlobals(state.tasks, repoId);
	}

	function getAllTasks(): Task[] {
		return state.tasks;
	}

	// ── Detect repo ───────────────────────────────────────────────────────
	// Repo detection is handled by initTodoStorage() in persistence.ts

	// ── Update status bar ────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const tasks = getTasksForRepo(currentRepoId);
		const counters = getCounters(tasks);
		const openCount = counters.open + counters.overdue + counters.dueSoon;
		if (openCount > 0) {
			let status = `📌 ${openCount} open`;
			if (counters.overdue > 0) status += ` · ${counters.overdue} overdue`;
			ctx.ui.setStatus("pi-todo", status);
		} else {
			ctx.ui.setStatus("pi-todo", undefined);
		}
	}

	// ── Startup ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentRepoId = await initTodoStorage(pi);
		state = await loadState();

		if (ctx.hasUI) {
			const snapshot = renderSnapshot(state, currentRepoId, ctx.ui.theme);
			if (snapshot) {
				pi.sendMessage(
					{ customType: "pi-todo-snapshot", content: snapshot, display: true },
					{ triggerTurn: false }
				);
			}
			updateStatus(ctx);
		}
	});

	// ── Context filtering — keep todos out of LLM context ─────────────────

	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter((m: any) => {
			if (m.role === "custom" && typeof m.customType === "string" && m.customType.startsWith("pi-todo-")) {
				return false;
			}
			return true;
		});
		return { messages: filtered };
	});

	// ── Message renderers ─────────────────────────────────────────────────

	pi.registerMessageRenderer("pi-todo-snapshot", (message, _options, _theme) => {
		return new Text(message.content as string, 0, 0);
	});

	pi.registerMessageRenderer("pi-todo-preview", (message, _options, _theme) => {
		return new Text(message.content as string, 0, 0);
	});

	// ── AI Tool ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the user's personal TODO board. Use to list, add, update, or complete tasks. " +
			"Tasks are persisted across sessions. Each task has a title, type (feature/bug/chore/research/review/personal), " +
			"priority, status, optional description, url, due date, and note. " +
			"Review tasks track PR reviews with metadata and support AI-powered summary and clone-review actions from the board.",
		promptSnippet: "Manage the user's TODO board — list, add, update, complete, or delete tasks (includes PR review tracking)",
		promptGuidelines: [
			"Use the todo tool when the user asks about their tasks, wants to add/check/complete todos, or asks you to manage their task board.",
			"When adding tasks, provide a concise title and a 2-3 sentence description that captures key details.",
			"For PR reviews, the user can use /todo <pr-url> to create review tasks. The board has AI summary (s), open in browser (o), and clone-review (c) actions.",
			"Task types: feature, bug, chore, research, review (PR reviews), personal (non-work). Review and personal tasks are always global.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "update", "complete", "delete"] as const),
			id: Type.Optional(Type.Number({ description: "Task ID (required for update, complete, delete)" })),
			title: Type.Optional(Type.String({ description: "Task title (required for add)" })),
			description: Type.Optional(Type.String({ description: "Concise 2-3 sentence description" })),
			type: Type.Optional(StringEnum(["feature", "bug", "chore", "research", "review", "personal"] as const)),
			priority: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
			status: Type.Optional(StringEnum(["open", "blocked", "done"] as const)),
			dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
			url: Type.Optional(Type.String({ description: "URL associated with the task (e.g. PR link)" })),
			note: Type.Optional(Type.String({ description: "Additional note" })),
			scope: Type.Optional(StringEnum(["repo", "all"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list": {
					const tasks = params.scope === "all" ? getAllTasks() : getTasksForRepo(currentRepoId);
					if (tasks.length === 0) {
						return {
							content: [{ type: "text", text: "No tasks found." }],
							details: { tasks: [] },
						};
					}
					const lines = tasks.map((t) => {
						let line = `#${t.id} [${t.status}] [${t.type}/${t.priority}] ${t.title}`;
						if (t.dueDate) line += ` (due: ${t.dueDate})`;
						if (t.url) line += `\n   URL: ${t.url}`;
						if (t.description) line += `\n   ${t.description}`;
						if (t.note) line += `\n   Note: ${t.note}`;
						return line;
					});
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { tasks, count: tasks.length },
					};
				}
				case "add": {
					if (!params.title) throw new Error("Title is required for adding a task");
					const scope = getTaskRepoId(params.type ?? "chore", currentRepoId);
					const nextId = getNextIdForScope(state.tasks, scope);
					const task = createTask(nextId, params.title, currentRepoId, {
						type: params.type,
						priority: params.priority,
						description: params.description,
						dueDate: params.dueDate,
						url: params.url,
						note: params.note,
					});
					state.tasks.push(task);
					await saveState(state);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Task #${task.id} created: "${task.title}" [${task.type}/${task.priority}]` }],
						details: { task },
					};
				}
				case "update": {
					if (!params.id) throw new Error("Task ID is required for update");
					const task = state.tasks.find((t) => t.id === params.id);
					if (!task) throw new Error(`Task #${params.id} not found`);
					if (params.title !== undefined) task.title = params.title;
					if (params.description !== undefined) task.description = params.description;
					if (params.type !== undefined) {
						task.type = params.type;
						// Auto-move repo based on type
						const newScope = getTaskRepoId(params.type, currentRepoId);
						if (task.repoId !== newScope) {
							task.repoId = newScope;
							// Re-number ID for the new scope
							task.id = getNextIdForScope(state.tasks, newScope);
						}
					}
					if (params.priority !== undefined) task.priority = params.priority;
					if (params.status !== undefined) task.status = params.status;
					if (params.dueDate !== undefined) task.dueDate = params.dueDate;
					if (params.url !== undefined) task.url = params.url;
					if (params.note !== undefined) task.note = params.note;
					task.updatedAt = Date.now();
					await saveState(state);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Task #${task.id} updated: "${task.title}"` }],
						details: { task },
					};
				}
				case "complete": {
					if (!params.id) throw new Error("Task ID is required for complete");
					const task = state.tasks.find((t) => t.id === params.id);
					if (!task) throw new Error(`Task #${params.id} not found`);
					task.status = "done";
					task.updatedAt = Date.now();
					await saveState(state);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Task #${task.id} completed: "${task.title}" ✓` }],
						details: { task },
					};
				}
				case "delete": {
					if (!params.id) throw new Error("Task ID is required for delete");
					const task = state.tasks.find((t) => t.id === params.id);
					if (!task) throw new Error(`Task #${params.id} not found`);
					state.tasks = state.tasks.filter((t) => t.id !== params.id);
					await saveState(state);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Task #${task.id} deleted: "${task.title}"` }],
						details: { task },
					};
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo "));
			text += theme.fg("muted", args.action ?? "");
			if (args.title) text += " " + theme.fg("dim", `"${args.title}"`);
			if (args.id) text += " " + theme.fg("dim", `#${args.id}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, _context) {
			const text = result.content?.[0];
			const content = text && "text" in text ? text.text : "Done";

			let output = theme.fg("success", content);
			if (expanded && result.details?.task) {
				const t = result.details.task as Task;
				if (t.description) {
					output += "\n  " + theme.fg("dim", t.description);
				}
			}
			return new Text(output, 0, 0);
		},
	});

	// ── /todo command ─────────────────────────────────────────────────────

	pi.registerCommand("todo", {
		description: "Open TODO board or add a task: /todo, /todo <description>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todo requires interactive mode", "error");
				return;
			}

			const trimmed = (args ?? "").trim();

			if (!trimmed) {
				await openBoard(ctx);
			} else {
				const text = trimmed.replace(/^["']|["']$/g, "");
				await captureTask(text, ctx);
			}
		},
	});

	// ── /todo-repo command ────────────────────────────────────────────────

	pi.registerCommand("todo-repo", {
		description: "Show current repo scope for TODO association",
		handler: async (_args, ctx) => {
			const label = currentRepoId === GLOBAL_REPO_ID ? "global (no git repo detected)" : currentRepoId;
			ctx.ui.notify(`TODO repo scope: ${label}`, "info");
		},
	});

	// ── /todo-clone-review command (needs ExtensionCommandContext for newSession) ──

	pi.registerCommand("todo-clone-review", {
		description: "Clone a PR and open a review session (internal, triggered from board)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Requires interactive mode", "error");
				return;
			}
			const taskId = pendingCloneReviewTaskId;
			pendingCloneReviewTaskId = null;
			if (!taskId) {
				ctx.ui.notify("No pending review task", "error");
				return;
			}
			const task = state.tasks.find((t) => t.id === taskId);
			if (!task || !task.prMeta) {
				ctx.ui.notify(`Task #${taskId} not found or not a review task`, "error");
				return;
			}
			await startCloneReviewSession(task, pi, ctx);
		},
	});

	// ── Ctrl+Shift+B shortcut ─────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "Open TODO board",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await openBoard(ctx);
		},
	});

	// ── Board UI ──────────────────────────────────────────────────────────

	async function openBoard(ctx: ExtensionContext) {
		await createBoardUI(ctx, state, currentRepoId, {
			onSave: async () => {
				await saveState(state);
				updateStatus(ctx);
			},
			onDelete: async (taskId: number) => {
				state.tasks = state.tasks.filter((t) => t.id !== taskId);
				await saveState(state);
				updateStatus(ctx);
			},
			onOpenUrl: async (url: string) => {
				await pi.exec("open", [url], { timeout: 5000 });
			},
			onAiSummary: async (task: Task) => {
				await showAiSummaryModal(task, pi, ctx, baml);
			},
			onCloneReview: async (task: Task) => {
				// Store task ID and trigger command (needs ExtensionCommandContext for newSession)
				pendingCloneReviewTaskId = task.id;
				pi.sendUserMessage("/todo-clone-review", { deliverAs: "followUp" });
			},
			onInject: async (task: Task) => {
				const lines: string[] = [];
				lines.push(`# Task #${task.id}: ${task.title}`);
				lines.push(`Type: ${task.type} | Priority: ${task.priority} | Status: ${task.status}`);
				if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
				if (task.description) lines.push(`\n${task.description}`);
				if (task.note) lines.push(`\nNote: ${task.note}`);
				if (task.url) lines.push(`URL: ${task.url}`);
				if (task.prMeta) {
					const pr = task.prMeta;
					lines.push(`PR: ${pr.owner}/${pr.repo} #${pr.number} by ${pr.author} (${pr.state})`);
				}
				pi.sendUserMessage(lines.join("\n"), { deliverAs: "followUp" });
			},
			getRepoId: () => currentRepoId,
			getAllTasks: () => getAllTasks(),
			getTasksForRepo: (repoId: string) => getTasksForRepo(repoId),
		});
	}

	// ── AI Capture ────────────────────────────────────────────────────────

	async function captureTask(text: string, ctx: ExtensionContext) {
		// Check if it's a PR URL
		const prUrl = parsePrUrl(text);
		if (prUrl) {
			await capturePrReview(prUrl, ctx);
			return;
		}

		// Show spinner while AI parses
		const parsed = await ctx.ui.custom<Partial<Task> | null>((_tui, theme, _kb, done) => {
			const loader = new BorderedLoader(_tui, theme, `Creating task: "${text}"`);
			loader.onAbort = () => done(null);

			(async () => {
				try {
					let result: Partial<Task> | null = null;

					// Tier 1: BAML — typed structured extraction
					if (baml?.available) {
						try {
							result = await parseTaskWithBaml(text, baml, ctx.modelRegistry);
						} catch (err: any) {
							ctx.ui.notify(`⚠ BAML ParseTask failed: ${(err as Error).message}. Using fallback.`, 'warning');
							result = null;
						}
					}

					// Tier 2: LLM
					if (!result) {
						const model = ctx.model;
						if (model) {
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
							if (auth?.ok && auth.apiKey) {
								result = await parseTaskWithLLM(text, model, auth.apiKey, auth.headers);
							}
						}
					}

					// Tier 3: Heuristic fallback
					done(result ?? parseTaskFallback(text));
				} catch {
					done(parseTaskFallback(text));
				}
			})();

			return loader;
		});

		if (parsed === null) {
			ctx.ui.notify("Task capture cancelled", "info");
			return;
		}

		// Show preview modal with Save/Discard
		const result = await showTaskPreviewModal(parsed, text, ctx);

		if (!result) {
			ctx.ui.notify("Task capture cancelled", "info");
			return;
		}

		// Create and save
		const effectiveScope = result.repoId ?? getTaskRepoId(result.type ?? "chore", currentRepoId);
		const task = createTask(
			getNextIdForScope(state.tasks, effectiveScope),
			result.title ?? text,
			effectiveScope,
			result,
		);
		state.tasks.push(task);
		await saveState(state);
		updateStatus(ctx);

		ctx.ui.notify(`✓ Task #${task.id} added: "${task.title}" [${task.type}]`, "info");
	}

	// ── PR Review Capture ─────────────────────────────────────────────────

	async function capturePrReview(prUrl: ReturnType<typeof parsePrUrl> & {}, ctx: ExtensionContext) {
		// Fetch PR metadata with spinner
		const prMeta = await ctx.ui.custom<PrMeta | null>((_tui, theme, _kb, done) => {
			const loader = new BorderedLoader(_tui, theme, `Fetching PR: ${prUrl.owner}/${prUrl.repo} #${prUrl.number}`);
			loader.onAbort = () => done(null);

			(async () => {
				try {
					const token = await discoverGitHubToken(prUrl.host, pi);
					const meta = await fetchPrMeta(prUrl, token);
					done(meta ?? fallbackPrMeta(prUrl));
				} catch {
					done(fallbackPrMeta(prUrl));
				}
			})();

			return loader;
		});

		if (!prMeta) {
			ctx.ui.notify("PR review capture cancelled", "info");
			return;
		}

		const title = `Review: ${prMeta.title} (${prUrl.owner}/${prUrl.repo} #${prUrl.number})`;
		const reviewNextId = getNextIdForScope(state.tasks, REVIEW_REPO_ID);
		const task = createTask(reviewNextId, title, currentRepoId, {
			type: "review",
			priority: "medium",
			url: prUrl.url,
			prMeta,
			description: `PR by ${prMeta.author} on branch ${prMeta.branch}. State: ${prMeta.state}.`,
		});
		state.tasks.push(task);
		await saveState(state);
		updateStatus(ctx);

		ctx.ui.notify(`✓ Review #${task.id} added: ${prUrl.owner}/${prUrl.repo} #${prUrl.number}`, "info");
	}

	// ── Task Preview Modal ────────────────────────────────────────────────

	async function showTaskPreviewModal(
		parsed: Partial<Task>,
		originalText: string,
		ctx: ExtensionContext
	): Promise<Partial<Task> | null> {
		return ctx.ui.custom<Partial<Task> | null>(
			(_tui, theme, _kb, done) => {
				// Editable copy of parsed fields
				const fields = {
					title: parsed.title ?? originalText,
					type: parsed.type ?? "chore",
					priority: parsed.priority ?? "medium",
					scope: currentRepoId,
					dueDate: parsed.dueDate ?? "",
					description: parsed.description ?? "",
				};

				type FieldKey = keyof typeof fields;
				const FIELDS: FieldKey[] = ["title", "type", "priority", "scope", "dueDate", "description"];
				const ACTIONS = ["save", "discard"] as const;
				type FocusArea = "fields" | "actions";

				let fieldIndex = 0;
				let actionIndex = 0;
				let focusArea: FocusArea = "fields";
				let editing = false;
				let editBuffer = "";
				let cachedLines: string[] | undefined;

				const TYPES = ["feature", "bug", "chore", "research", "review", "personal"];
				const PRIORITIES = ["low", "medium", "high"];
				const SCOPES = [...new Set([currentRepoId, GLOBAL_REPO_ID, WORK_REPO_ID])];

				function invalidate() {
					cachedLines = undefined;
				}

				function pad(s: string, len: number): string {
					const vis = visibleWidth(s);
					return s + " ".repeat(Math.max(0, len - vis));
				}

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

				function handleInput(data: string) {
					if (editing) {
						handleEditInput(data);
					} else {
						handleNavInput(data);
					}
					invalidate();
					_tui.requestRender();
				}

				function handleNavInput(data: string) {
					if (matchesKey(data, Key.escape) || data === "q") {
						done(null);
						return;
					}

					if (matchesKey(data, Key.up) || data === "k") {
						if (focusArea === "actions") {
							focusArea = "fields";
							fieldIndex = FIELDS.length - 1;
						} else if (fieldIndex > 0) {
							fieldIndex--;
						}
					} else if (matchesKey(data, Key.down) || data === "j") {
						if (focusArea === "fields") {
							if (fieldIndex < FIELDS.length - 1) {
								fieldIndex++;
							} else {
								focusArea = "actions";
								actionIndex = 0;
							}
						}
					} else if (matchesKey(data, Key.left) || data === "h") {
						if (focusArea === "actions" && actionIndex > 0) actionIndex--;
					} else if (matchesKey(data, Key.right) || data === "l") {
						if (focusArea === "actions" && actionIndex < ACTIONS.length - 1) actionIndex++;
					} else if (matchesKey(data, Key.tab)) {
						if (focusArea === "fields") {
							focusArea = "actions";
							actionIndex = 0;
						} else {
							focusArea = "fields";
							fieldIndex = 0;
						}
					} else if (matchesKey(data, Key.enter)) {
						if (focusArea === "actions") {
							if (ACTIONS[actionIndex] === "save") {
								done({
									title: fields.title,
									type: fields.type as Task["type"],
									priority: fields.priority as Task["priority"],
									repoId: fields.scope,
									dueDate: fields.dueDate || undefined,
									description: fields.description || undefined,
								});
							} else {
								done(null);
							}
						} else {
							const field = FIELDS[fieldIndex];
							if (field === "type") {
								const idx = TYPES.indexOf(fields.type);
								fields.type = TYPES[(idx + 1) % TYPES.length];
							} else if (field === "priority") {
								const idx = PRIORITIES.indexOf(fields.priority);
								fields.priority = PRIORITIES[(idx + 1) % PRIORITIES.length];
							} else if (field === "scope") {
								const idx = SCOPES.indexOf(fields.scope);
								fields.scope = SCOPES[(idx + 1) % SCOPES.length];
							} else {
								editing = true;
								editBuffer = fields[field];
							}
						}
					}
				}

				function handleEditInput(data: string) {
					if (matchesKey(data, Key.enter)) {
						const field = FIELDS[fieldIndex];
						if (field === "dueDate" && editBuffer.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(editBuffer.trim())) {
							// Invalid date format, ignore
							editing = false;
							return;
						}
						fields[field] = editBuffer.trim();
						editing = false;
					} else if (matchesKey(data, Key.escape)) {
						editing = false;
					} else if (matchesKey(data, Key.backspace)) {
						editBuffer = editBuffer.slice(0, -1);
					} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
						editBuffer += data;
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const contentW = width - 4;
					const lines: string[] = [];

					// Top border
					const titleText = " 📋 New Task ";
					const titleLen = visibleWidth(titleText);
					const leftDash = 1;
					const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
					lines.push(
						theme.fg("accent", "╭" + "─".repeat(leftDash)) +
							theme.fg("accent", theme.bold(titleText)) +
							theme.fg("accent", "─".repeat(rightDash) + "╮")
					);

					lines.push(emptyRow(contentW));

					// Fields
					for (let i = 0; i < FIELDS.length; i++) {
						const field = FIELDS[i];
						const selected = focusArea === "fields" && i === fieldIndex;
						const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
						const label = theme.fg("muted", padRight(fieldLabel(field) + ":", 14));

						let value: string;
						if (editing && selected) {
							value = theme.fg("accent", editBuffer + "█");
						} else if (field === "scope") {
							value = shortRepoName(fields[field]);
						} else {
							value = fields[field] || theme.fg("dim", "(none)");
						}

						let hint = "";
						if (!editing) {
							if (field === "type" || field === "priority" || field === "scope") hint = theme.fg("dim", " (Enter to cycle)");
							else hint = theme.fg("dim", " (Enter to edit)");
						}

						// Description gets special treatment — show as multi-line
						if (field === "description" && !editing && fields.description) {
							lines.push(row(prefix + label, contentW));
							const descLines = wordWrap(fields.description, contentW - 6);
							for (const dl of descLines) {
								lines.push(row("    " + (selected ? theme.fg("accent", dl) : theme.fg("dim", dl)), contentW));
							}
							if (selected) {
								lines.push(row("    " + theme.fg("dim", "(Enter to edit)"), contentW));
							}
						} else {
							lines.push(row(prefix + label + value + hint, contentW));
						}
					}

					lines.push(emptyRow(contentW));

					// Actions
					let actionLine = "    ";
					for (let i = 0; i < ACTIONS.length; i++) {
						const label = ACTIONS[i].charAt(0).toUpperCase() + ACTIONS[i].slice(1);
						const selected = focusArea === "actions" && i === actionIndex;
						if (i > 0) actionLine += "     ";
						if (selected) {
							actionLine += theme.fg("accent", theme.bold(`[ ${label} ]`));
						} else {
							actionLine += theme.fg("muted", `  ${label}  `);
						}
					}
					lines.push(row(actionLine, contentW));

					lines.push(emptyRow(contentW));

					// Footer hints
					const hints = editing
						? "Enter save · Esc cancel"
						: "↑↓ navigate · Enter select · Tab actions · Esc close";
					lines.push(row(theme.fg("dim", "  " + hints), contentW));

					// Bottom border
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
					width: "60%",
					minWidth: 50,
					maxHeight: "60%",
				},
			}
		);
	}
}

// ── Utility functions ─────────────────────────────────────────────────────

function fieldLabel(field: string): string {
	switch (field) {
		case "title":
			return "Title";
		case "type":
			return "Type";
		case "priority":
			return "Priority";
		case "scope":
			return "Scope";
		case "dueDate":
			return "Due";
		case "description":
			return "Description";
		default:
			return field;
	}
}

function padRight(str: string, width: number): string {
	if (str.length >= width) return str;
	return str + " ".repeat(width - str.length);
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
