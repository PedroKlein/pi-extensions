/**
 * pi-handoff — Session handoff for Pi.
 *
 * Provides:
 * - /handoff [goal] command: gathers context, agent produces handoff, writes file, pbcopy
 * - /pickup [repo] command: loads latest handoff, archives it, injects into session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	resolveRepoSlug,
	writeHandoff,
	consumeHandoff,
	hasHandoff,
	buildPickupMessage,
	getLatestPath,
} from "./handoff.js";
import { randomUUID } from "node:crypto";

export default function piHandoff(pi: ExtensionAPI): void {
	// ─── Helper: RPC call to pi-task (via events) ─────────────────

	function queryPiTask(method: string, params?: any): Promise<any> {
		return new Promise((resolve) => {
			const requestId = randomUUID();
			let unsub: (() => void) | undefined;
			const timeout = setTimeout(() => { unsub?.(); resolve(null); }, 2000);

			unsub = pi.events.on(`pi-task:rpc:reply:${requestId}` as any, (reply: any) => {
				if (reply.requestId !== requestId) return;
				clearTimeout(timeout);
				unsub?.();
				resolve(reply.success ? reply.data : null);
			});

			pi.events.emit("pi-task:rpc:request" as any, { requestId, method, params });
		});
	}
	// ─── Helper: get repo slug from git ───────────────────────────────

	async function getRepoSlug(): Promise<string> {
		try {
			const result = await pi.exec("git", ["remote", "get-url", "origin"], { timeout: 5000 });
			const cwd = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
			return resolveRepoSlug(
				result.code === 0 ? result.stdout.trim() : null,
				cwd.code === 0 ? cwd.stdout.trim() : process.cwd(),
			);
		} catch {
			return resolveRepoSlug(null, process.cwd());
		}
	}

	// ─── Helper: gather context for the agent ─────────────────────────

	async function gatherContext(): Promise<string> {
		const sections: string[] = [];

		// Git state
		try {
			const branch = await pi.exec("git", ["branch", "--show-current"], { timeout: 5000 });
			const status = await pi.exec("git", ["status", "--short"], { timeout: 5000 });
			const log = await pi.exec("git", ["log", "--oneline", "-5"], { timeout: 5000 });

			if (branch.code === 0) {
				sections.push(`**Git branch**: ${branch.stdout.trim()}`);
			}
			if (status.code === 0 && status.stdout.trim()) {
				const files = status.stdout.trim().split("\n").length;
				sections.push(`**Uncommitted changes**: ${files} file(s)`);
			}
			if (log.code === 0) {
				sections.push(`**Recent commits**:\n${log.stdout.trim()}`);
			}
		} catch { /* git not available */ }

		// Plan state (via pi-task RPC event — graceful if pi-task not loaded)
		try {
			const planData = await queryPiTask("getActivePlan");
			if (planData?.plan) {
				const plan = planData.plan;
				const done = plan.tasks.filter((t: any) => t.status === "done").length;
				const total = plan.tasks.length;
				const next = plan.tasks.find((t: any) => t.status === "ready" || t.status === "in-progress");
				sections.push(`**Active plan**: ${plan.name || "unnamed"} (${done}/${total} done)${next ? `, next: ${next.id}` : ""}`);
			}
		} catch { /* pi-task not available */ }

		return sections.join("\n\n");
	}

	// ─── /handoff Command ─────────────────────────────────────────────

	pi.registerCommand("handoff", {
		description: "Generate a structured handoff for the next session. Usage: /handoff [goal for next session]",
		handler: async (args, ctx) => {
			const repoSlug = await getRepoSlug();
			const context = await gatherContext();
			const goal = args.trim() || "";

			// Build the instruction for the agent
			const instruction = [
				`## Handoff Request`,
				``,
				`Generate a handoff document for the next session.`,
				goal ? `**Goal for next session**: ${goal}` : `**Goal**: Infer from session context (ask if unclear).`,
				``,
				`### Auto-gathered context`,
				context || "(no context available)",
				``,
				`### Instructions`,
				`Load the handoff skill if available. Produce a structured handoff document optimized for what the NEXT session will need to cold-start on the goal.`,
				``,
				`Think about:`,
				`- What planning artifacts exist and their state (plan_tasks, PLAN.md, babysitter processes, etc.)`,
				`- What decisions were made in this session that aren't captured in any file`,
				`- What the receiver needs to read first (files, docs, skills)`,
				`- What approaches were tried and didn't work`,
				`- What methodology/workflow the next session should follow`,
				``,
				`Ask me 1-2 clarifying questions if anything is unclear about what to include. Keep it brief.`,
				``,
				`When done, output the handoff content between \`\`\`handoff markers. I'll handle writing the file.`,
				``,
				`The handoff will be saved to: ~/.pi/handoffs/${repoSlug}/latest.md`,
			].join("\n");

			// Inject the instruction as a follow-up message
			pi.sendUserMessage(instruction, { deliverAs: "followUp" as any });

			// Set up a message renderer to capture ```handoff blocks
			// Actually, simpler: let the agent use write tool to write the file directly
			// and we just handle the clipboard part

			ctx.ui.notify(`📋 Handoff initiated for ${repoSlug}. Produce the handoff content.`, "info");
		},
	});

	// ─── Post-handoff: agent writes the file, we handle clipboard ─────

	// Listen for writes to the handoff path
	pi.on("tool_result", async (event: any) => {
		if (event.toolName === "write") {
			const path = event.params?.path || "";
			if (path.includes(".pi/handoffs/") && path.endsWith("latest.md")) {
				// Copy pickup message to clipboard
				const repoSlug = await getRepoSlug();
				const pickupMsg = buildPickupMessage(repoSlug);
				try {
					const clipCmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
					await pi.exec("sh", ["-c", `printf '%s' ${JSON.stringify(pickupMsg)} | ${clipCmd}`], { timeout: 5000 });
				} catch { /* clipboard not available */ }
			}
		}
	});

	// ─── /pickup Command ──────────────────────────────────────────────

	pi.registerCommand("pickup", {
		description: "Load the latest handoff for this repo (or specify another). Usage: /pickup [repo-slug]",
		handler: async (args, ctx) => {
			let repoSlug: string;

			if (args.trim()) {
				// Cross-repo pickup: use the argument as the slug
				repoSlug = args.trim();
			} else {
				repoSlug = await getRepoSlug();
			}

			if (!hasHandoff(repoSlug)) {
				ctx.ui.notify(`No handoff found for "${repoSlug}". Nothing to pick up.`, "warning");
				return;
			}

			const result = consumeHandoff(repoSlug);
			if (!result) {
				ctx.ui.notify("Failed to read handoff file.", "error");
				return;
			}

			// Inject the handoff content into the conversation
			pi.sendUserMessage(
				[
					`# Session Handoff (picked up)`,
					``,
					`The following handoff was created by a previous session. It has been archived.`,
					``,
					result.content,
				].join("\n"),
				{ deliverAs: "followUp" as any },
			);

			ctx.ui.notify(`📋 Handoff loaded and archived. Goal: check the content above.`, "info");
		},
	});
}
