/**
 * Minimal structural host surface the gateway needs from its harness.
 *
 * Both pi (`@earendil-works/pi-coding-agent`) and oh-my-pi
 * (`@oh-my-pi/pi-coding-agent`) expose a compatible `on` + `registerCommand`,
 * so typing against this structural shape lets the shared runtime + command
 * modules serve both harnesses without importing either package.
 */

/** Notify severity, shared by both harnesses. */
export type NotifyType = "info" | "warning" | "error";

/** Structural session_start / message_end context. */
export interface GatewayHostContext {
	modelRegistry: unknown;
	ui: { notify(message: string, type?: NotifyType): void };
	isIdle?: () => boolean;
	model?: { provider?: string; id?: string };
}

/** Structural harness API — the subset the gateway uses. */
export interface GatewayHostApi {
	on(event: string, handler: (event: any, ctx: any) => any): void;
	events?: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data?: unknown): void;
	};
	setModel?(model: unknown): Promise<boolean>;
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => unknown;
			handler: (...args: any[]) => any;
		},
	): void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}
