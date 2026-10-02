import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function reportNestedUsage(
	pi: ExtensionAPI,
	operation: string,
	selectedModel: Model<Api>,
	response: AssistantMessage,
	durationMs: number,
): void {
	pi.events.emit("pi-audit:usage", {
		source: "pi-todo",
		operation,
		model: `${selectedModel.provider}/${selectedModel.id}`,
		input: response.usage.input,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		output: response.usage.output,
		reasoning: response.usage.reasoning ?? 0,
		durationMs,
		trigger: "user",
		status: response.stopReason === "error" || response.stopReason === "aborted" ? "error" : "complete",
		route: `${response.provider}/${response.model}`,
	});
}
