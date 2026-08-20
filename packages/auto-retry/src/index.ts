/**
 * Auto-Retry Extension
 *
 * Detects when the LLM produces a malformed tool call (JSON parse error)
 * and automatically sends a follow-up user message asking it to retry
 * with smaller, simpler edits.
 *
 * The error surfaces as an AssistantMessage with:
 *   stopReason: "error"
 *   errorMessage containing "JSON" or "Unexpected" parse errors
 *
 * Retry behavior:
 *   - Max 2 consecutive retries per agent run (resets on success)
 *   - Flash notification on retry so you know what happened
 *   - Gives up after max retries to avoid infinite loops
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_RETRIES = 2;

export const RETRY_MESSAGE =
	"Your last tool call failed because it produced malformed JSON. " +
	"This usually happens with large edit blocks containing special characters. " +
	"Please retry the same change, but break it into smaller, separate edit calls — " +
	"each with a short, targeted oldText. Do not combine many changes into one large edit.";

export function isJsonParseError(errorMessage: string): boolean {
	const lower = errorMessage.toLowerCase();
	return (
		lower.includes("unexpected") && (lower.includes("json") || lower.includes("position")) ||
		lower.includes("json") && lower.includes("parse") ||
		lower.includes("unterminated string") ||
		lower.includes("bad control character") ||
		lower.includes("expected ',' or '}'")
	);
}

export default function (pi: ExtensionAPI) {
	let consecutiveRetries = 0;
	let activeRetry: {
		attempt: number;
		startedAt: number;
		model: string;
	} | undefined;

	const modelName = (ctx: { model?: { provider?: string; id?: string } }): string =>
		ctx.model?.provider && ctx.model?.id
			? `${ctx.model.provider}/${ctx.model.id}`
			: "unknown";

	const totals = (messages: unknown[]) => {
		const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
		for (const message of messages) {
			if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
			const value = (message as { usage?: Partial<typeof usage> }).usage;
			usage.input += value?.input ?? 0;
			usage.cacheRead += value?.cacheRead ?? 0;
			usage.cacheWrite += value?.cacheWrite ?? 0;
			usage.output += value?.output ?? 0;
			usage.reasoning += value?.reasoning ?? 0;
		}
		return usage;
	};

	// Reset counter on successful turns
	pi.on("turn_end", async (event) => {
		const msg = event.message;
		if (msg.role === "assistant" && msg.stopReason !== "error") {
			consecutiveRetries = 0;
		}
	});

	// Detect malformed tool call errors and retry
	pi.on("agent_end", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		// Check the last assistant message
		const last = messages[messages.length - 1];
		if (last.role !== "assistant") return;

		if (activeRetry) {
			const status = last.stopReason === "error" ? "error" : "complete";
			pi.events.emit("pi-audit:usage", {
				source: "pi-auto-retry",
				operation: `retry-${status}`,
				model: activeRetry.model,
				...totals(messages),
				durationMs: Date.now() - activeRetry.startedAt,
				trigger: "automatic",
				status,
				retryLayer: "malformed-tool",
				attempt: activeRetry.attempt,
				route: activeRetry.model,
			});
			activeRetry = undefined;
		}

		const assistant = last as {
			role: "assistant";
			stopReason: string;
			errorMessage?: string;
		};

		if (assistant.stopReason !== "error" || !assistant.errorMessage) return;
		if (!isJsonParseError(assistant.errorMessage)) return;

		// Enforce retry limit
		if (consecutiveRetries >= MAX_RETRIES) {
			const theme = ctx.ui.theme;
			ctx.ui.notify(
				theme.fg("error", `⛔ Auto-retry gave up after ${MAX_RETRIES} attempts — malformed JSON persists`),
				"error",
			);
			consecutiveRetries = 0;
			return;
		}

		consecutiveRetries++;
		const model = modelName(ctx);
		activeRetry = {
			attempt: consecutiveRetries,
			startedAt: Date.now(),
			model,
		};
		pi.events.emit("pi-audit:retry-scheduled", {
			retryLayer: "malformed-tool",
			attempt: consecutiveRetries,
			model,
		});
		pi.events.emit("pi-audit:usage", {
			source: "pi-auto-retry",
			operation: "retry-start",
			model,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			reasoning: 0,
			durationMs: 0,
			trigger: "automatic",
			status: "start",
			retryLayer: "malformed-tool",
			attempt: consecutiveRetries,
			route: model,
		});

		const theme = ctx.ui.theme;
		ctx.ui.notify(
			theme.fg("warning", `🔄 Malformed tool call JSON — auto-retrying (${consecutiveRetries}/${MAX_RETRIES})`),
			"warning",
		);

		// Send as a new user message to trigger a fresh turn
		pi.sendUserMessage(RETRY_MESSAGE, { deliverAs: "followUp" });
	});
}
