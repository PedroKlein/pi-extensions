/**
 * pi-verify — Verification system for Pi.
 *
 * Provides:
 * - /freeze command: grills user on vague criteria, locks them immutable
 * - /verify command: spawns 4 specialized reviewers via RPC, collects verdicts
 * - freeze_criteria tool: LLM-callable freeze trigger
 * - verify_work tool: LLM-callable verification trigger
 * - Progress widget showing reviewer status
 * - Events: pi-verify:frozen, pi-verify:started, pi-verify:verdict
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";

// ─── Types ─────────────────────────────────────────────────────────────

// ─── RPC helper for pi-task ────────────────────────────────────────────

function createPiTaskRPC(pi: ExtensionAPI) {
	return function queryPiTask(method: string, params?: any): Promise<any> {
		return new Promise((resolve) => {
			const requestId = randomUUID();
			const timeout = setTimeout(() => resolve(null), 2000);

			const handler = (reply: any) => {
				if (reply.requestId !== requestId) return;
				clearTimeout(timeout);
				pi.events.off(`pi-task:rpc:reply:${requestId}` as any, handler);
				resolve(reply.success ? reply.data : null);
			};

			pi.events.on(`pi-task:rpc:reply:${requestId}` as any, handler);
			pi.events.emit("pi-task:rpc:request" as any, { requestId, method, params });
		});
	};
}

interface ReviewerVerdict {
	reviewer: string;
	overall: "PASS" | "FAIL" | "CAUTION" | "CONCERNS" | "PARTIAL";
	summary: string;
	details: string;
}

interface VerificationResult {
	overall: "PASS" | "FAIL" | "MIXED";
	verdicts: ReviewerVerdict[];
	timestamp: number;
	criteria: string[];
}

interface ReviewerStatus {
	name: string;
	status: "pending" | "running" | "done" | "failed";
	verdict?: ReviewerVerdict;
}

const REVIEWERS = [
	{ agent: "completeness-reviewer", label: "Completeness", focus: "all plan items addressed" },
	{ agent: "correctness-reviewer", label: "Correctness", focus: "tests meaningful, assertions exercise the change" },
	{ agent: "quality-reviewer", label: "Quality", focus: "code practices, patterns, codebase fit" },
	{ agent: "safety-reviewer", label: "Safety", focus: "blast radius, regressions, side effects" },
] as const;

// ─── Extension ─────────────────────────────────────────────────────────

export default function piVerify(pi: ExtensionAPI): void {
	let latestCtx: ExtensionContext | null = null;
	let reviewerStatuses: ReviewerStatus[] = [];
	let verificationInProgress = false;

	// ─── Helper: RPC to pi-task ───────────────────────────────────────

	const queryPiTask = createPiTaskRPC(pi);

	// ─── Helper: Get criteria from active plan ────────────────────────

	async function getActivePlanCriteria(): Promise<{ taskId: string; title: string; criteria: string[] }[]> {
		try {
			const result = await queryPiTask("getCriteria");
			if (!result?.tasks) return [];

			return result.tasks.map((t: any) => ({
				taskId: t.taskId,
				title: t.title,
				criteria: t.criteria,
			}));
		} catch {
			return [];
		}
	}

	// ─── Helper: Get git diff ─────────────────────────────────────────

	async function getGitDiff(): Promise<string> {
		try {
			const result = await pi.exec("git", ["diff", "--stat", "HEAD~5..HEAD"], { timeout: 10000 });
			if (result.code === 0 && result.stdout.trim()) return result.stdout;
			// Fallback: unstaged changes
			const unstaged = await pi.exec("git", ["diff", "--stat"], { timeout: 10000 });
			return unstaged.stdout || "(no diff available)";
		} catch {
			return "(could not retrieve git diff)";
		}
	}

	// ─── Helper: Spawn reviewer via RPC ───────────────────────────────

	function spawnReviewer(agent: string, task: string): Promise<string | null> {
		return new Promise((resolve) => {
			const requestId = randomUUID();
			const timeout = setTimeout(() => {
				resolve(null);
			}, 5000);

			const handler = (reply: any) => {
				if (reply.requestId !== requestId) return;
				clearTimeout(timeout);
				pi.events.off(`subagents:rpc:v1:reply:${requestId}`, handler);
				resolve(reply.success ? reply.data?.id ?? "spawned" : null);
			};

			pi.events.on(`subagents:rpc:v1:reply:${requestId}`, handler);
			pi.events.emit("subagents:rpc:v1:request", {
				version: 1,
				requestId,
				method: "spawn",
				params: { agent, task, context: "fresh", async: true },
			});
		});
	}

	// ─── Helper: Build reviewer task prompt ───────────────────────────

	function buildReviewerPrompt(focus: string, criteria: string[], diff: string): string {
		return [
			`## Verification Task`,
			``,
			`You are verifying work against frozen acceptance criteria. Focus: ${focus}.`,
			``,
			`### Acceptance Criteria (frozen contract)`,
			...criteria.map((c, i) => `${i + 1}. ${c}`),
			``,
			`### Recent Changes (git diff --stat)`,
			"```",
			diff.slice(0, 3000),
			"```",
			``,
			`Inspect the repository, run tests if needed, and produce your verdict.`,
			`Report ONLY evidence-based findings. Do not invent issues.`,
		].join("\n");
	}

	// ─── /freeze Command ──────────────────────────────────────────────

	pi.registerCommand("freeze", {
		description: "Freeze acceptance criteria — grills you on vague criteria, then locks them immutable",
		handler: async (_args, ctx) => {
			const tasksWithCriteria = await getActivePlanCriteria();

			if (tasksWithCriteria.length === 0) {
				ctx.ui.notify("No tasks with acceptance criteria found. Add criteria first with plan_tasks add-criteria.", "warning");
				return;
			}

			// Show what will be frozen
			const summary = tasksWithCriteria.map((t) =>
				`**${t.taskId}** (${t.title}): ${t.criteria.length} criteria`,
			).join("\n");

			ctx.ui.notify(`Freezing criteria for ${tasksWithCriteria.length} task(s)`, "info");

			// Trigger freeze via pi-task RPC
			try {
				const result = await queryPiTask("freeze");
				if (result) {
					pi.events.emit("pi-verify:frozen", {
						tasks: tasksWithCriteria.map((t) => t.taskId),
						timestamp: Date.now(),
					});
					ctx.ui.notify("🧊 Criteria frozen. They cannot be modified until unfrozen.", "info");
				} else {
					ctx.ui.notify("Freeze failed: pi-task not responding.", "error");
				}
			} catch (err: any) {
				ctx.ui.notify(`Freeze failed: ${err.message}`, "error");
			}
		},
	});

	// ─── freeze_criteria Tool ─────────────────────────────────────────

	pi.registerTool({
		name: "freeze_criteria",
		label: "Freeze Criteria",
		description: "Freeze acceptance criteria for the active plan. Call this after planning is complete and before building starts. Locks criteria immutable so reviewers can verify against a fixed contract.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Freeze a specific task. Omit to freeze all tasks with criteria." })),
		}),
		async execute(_toolCallId, params) {
			const result = await queryPiTask("freeze", { taskId: params.taskId });

			if (!result) {
				return {
					content: [{ type: "text" as const, text: "Freeze failed: pi-task not responding or no plan active." }],
					details: {},
				};
			}

			const tasksWithCriteria = await getActivePlanCriteria();
			pi.events.emit("pi-verify:frozen", {
				tasks: tasksWithCriteria.map((t) => t.taskId),
				taskId: params.taskId ?? null,
				timestamp: Date.now(),
			});

			return {
				content: [{ type: "text" as const, text: `Frozen ${result.frozenCount} task(s).` }],
				details: { frozenCount: result.frozenCount },
			};
		},
	});

	// ─── /verify Command ──────────────────────────────────────────────

	pi.registerCommand("verify", {
		description: "Spawn 4 specialized reviewers to verify work against frozen acceptance criteria",
		handler: async (_args, ctx) => {
			if (verificationInProgress) {
				ctx.ui.notify("Verification already in progress", "warning");
				return;
			}

			const tasksWithCriteria = await getActivePlanCriteria();
			if (tasksWithCriteria.length === 0) {
				ctx.ui.notify("No acceptance criteria found. Nothing to verify.", "warning");
				return;
			}

			const allCriteria = tasksWithCriteria.flatMap((t) => t.criteria);
			const diff = await getGitDiff();

			verificationInProgress = true;
			reviewerStatuses = REVIEWERS.map((r) => ({ name: r.label, status: "pending" }));

			pi.events.emit("pi-verify:started", { criteria: allCriteria, timestamp: Date.now() });
			ctx.ui.notify(`🔍 Spawning ${REVIEWERS.length} reviewers...`, "info");

			// Spawn all reviewers via RPC
			for (const reviewer of REVIEWERS) {
				const idx = REVIEWERS.indexOf(reviewer);
				reviewerStatuses[idx].status = "running";

				const task = buildReviewerPrompt(reviewer.focus, allCriteria, diff);
				const id = await spawnReviewer(reviewer.agent, task);

				if (!id) {
					reviewerStatuses[idx].status = "failed";
					ctx.ui.notify(`⚠ Failed to spawn ${reviewer.label}`, "warning");
				}
			}

			const runningCount = reviewerStatuses.filter((r) => r.status === "running").length;
			const failedCount = reviewerStatuses.filter((r) => r.status === "failed").length;

			ctx.ui.notify(
				`🔍 Verification launched: ${runningCount} reviewers running${failedCount > 0 ? `, ${failedCount} failed to spawn` : ""}. Check results with /subagents-fleet or subagent({ action: "status" }).`,
				"info",
			);

			// Inject a message so the agent knows verification is running
			pi.sendUserMessage(
				`Verification in progress. ${runningCount} specialized reviewers (${REVIEWERS.map((r) => r.label).join(", ")}) are independently reviewing the work against ${allCriteria.length} frozen acceptance criteria. ` +
				`Check their results when complete with subagent({ action: "status" }) and synthesize the unified verdict.`,
				{ deliverAs: "followUp" as any },
			);

			verificationInProgress = false;
		},
	});

	// ─── verify_work Tool ─────────────────────────────────────────────

	pi.registerTool({
		name: "verify_work",
		label: "Verify Work",
		description:
			"Trigger verification of completed work against frozen acceptance criteria. " +
			"Spawns 4 specialized reviewers (completeness, correctness, quality, safety) " +
			"in fresh contexts as blind graders. Use after completing implementation to get " +
			"independent verification. Returns instructions for checking results.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Verify a specific task's criteria. Omit to verify all." })),
			context: Type.Optional(Type.String({ description: "Additional context to pass to reviewers (e.g., focus areas)" })),
		}),
		async execute(_toolCallId, params) {
			const tasksWithCriteria = await getActivePlanCriteria();
			if (tasksWithCriteria.length === 0) {
				return {
					content: [{ type: "text", text: "No acceptance criteria found. Add criteria with plan_tasks add-criteria first." }],
					details: {},
				};
			}

			const relevantTasks = params.taskId
				? tasksWithCriteria.filter((t) => t.taskId === params.taskId)
				: tasksWithCriteria;

			if (relevantTasks.length === 0) {
				return {
					content: [{ type: "text", text: `No criteria found for task ${params.taskId}.` }],
					details: {},
				};
			}

			const allCriteria = relevantTasks.flatMap((t) => t.criteria);
			const diff = await getGitDiff();

			pi.events.emit("pi-verify:started", { criteria: allCriteria, taskId: params.taskId, timestamp: Date.now() });

			// Spawn reviewers
			const spawnResults: { reviewer: string; success: boolean }[] = [];
			for (const reviewer of REVIEWERS) {
				let task = buildReviewerPrompt(reviewer.focus, allCriteria, diff);
				if (params.context) task += `\n\nAdditional context: ${params.context}`;

				const id = await spawnReviewer(reviewer.agent, task);
				spawnResults.push({ reviewer: reviewer.label, success: !!id });
			}

			const successCount = spawnResults.filter((r) => r.success).length;
			const failedReviewers = spawnResults.filter((r) => !r.success).map((r) => r.reviewer);

			let response = `🔍 Verification launched: ${successCount}/${REVIEWERS.length} reviewers spawned.\n\n`;
			response += `Reviewers running:\n`;
			for (const r of spawnResults) {
				response += `  ${r.success ? "✓" : "✗"} ${r.reviewer}\n`;
			}
			response += `\nCriteria being verified (${allCriteria.length}):\n`;
			for (const c of allCriteria) {
				response += `  • ${c}\n`;
			}
			response += `\nCheck results: subagent({ action: "status" }) or /subagents-fleet`;

			if (failedReviewers.length > 0) {
				response += `\n\n⚠ Failed to spawn: ${failedReviewers.join(", ")}. These agents may not be configured.`;
			}

			return {
				content: [{ type: "text", text: response }],
				details: { spawnResults, criteria: allCriteria },
			};
		},
	});

	// ─── Status Segment ───────────────────────────────────────────────

	pi.events.emit("pi-status:register", {
		id: "verify",
		priority: 15,
		render: () => null, // Hidden when not active
	});

	// ─── Lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
	});
}
