/**
 * pi-gateway: virtual provider that exposes tier aliases (heavy-1, medium-1,
 * light-1, plus family-pinned variants like heavy-hai-1) routing to already-
 * registered pi providers with automatic failover on cap hits.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGatewayCommand } from "./command.js";
import { AliasesConfigError, loadAliasesConfig } from "./config.js";
import { GatewayController } from "./controller.js";
import { installRefreshTimer, type RefreshTimerHandle } from "./refresh-timer.js";
import { resolveBackends } from "./resolver.js";
import { GatewayStateError } from "./state.js";
import { registerGatewayTransport, setGatewayRoutes } from "./transport.js";

export const EXTENSION_NAME = "pi-gateway";

export const ALIASES_PATH =
	process.env.PI_GATEWAY_ALIASES_PATH ?? join(homedir(), ".pi", "agent", "aliases.json");
export const STATE_PATH =
	process.env.PI_GATEWAY_STATE_PATH ?? join(homedir(), ".pi", "agent", "gateway-state.json");

export default function (pi: ExtensionAPI) {
	let controller: GatewayController | undefined;
	let refreshTimer: RefreshTimerHandle | undefined;

	async function buildController(ctx: {
		modelRegistry: unknown;
		ui: { notify: (m: string, t?: "info" | "warning" | "error") => void };
		isIdle?: () => boolean;
	}): Promise<void> {
		const aliases = loadAliasesConfig(ALIASES_PATH);
		controller = new GatewayController({
			aliases,
			statePath: STATE_PATH,
			registry: ctx.modelRegistry as never,
			register: (name, cfg) => pi.registerProvider(name, cfg as never),
			setRoutes: setGatewayRoutes,
			notify: (msg, type) => ctx.ui.notify(msg, type),
		});
		controller.requestReregister();

		// Install (or re-install) the periodic token-refresh timer.
		refreshTimer?.stop();
		const { backends } = resolveBackends(aliases, ctx.modelRegistry as never);
		refreshTimer = installRefreshTimer({
			backends,
			isIdle: () => (ctx.isIdle ? ctx.isIdle() : true),
			onTick: () => controller?.requestReregister(),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// Register the gateway api transport once, before any provider registration,
		// so pi can resolve `api: "gateway"` when a gateway alias is selected.
		registerGatewayTransport();
		try {
			await buildController(ctx);
		} catch (err) {
			if (err instanceof AliasesConfigError && err.cause === "missing") {
				ctx.ui.notify(
					`${EXTENSION_NAME}: no ${ALIASES_PATH} found — extension inactive. Create one to enable gateway/*.`,
					"info",
				);
				return;
			}
			if (err instanceof AliasesConfigError || err instanceof GatewayStateError) {
				ctx.ui.notify(`${EXTENSION_NAME}: ${err.message}`, "error");
				return;
			}
			ctx.ui.notify(
				`${EXTENSION_NAME}: unexpected error on session_start: ${(err as Error).message}`,
				"error",
			);
		}

		registerGatewayCommand(pi, {
			getController: () => controller,
			statePath: STATE_PATH,
			aliasesPath: ALIASES_PATH,
			rebuildController: () => buildController(ctx),
		});
	});

	pi.on("message_end", async (event, ctx) => {
		if (!controller) return;
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		controller.handleMessageEnd({
			errorMessage: msg.errorMessage,
			stopReason: msg.stopReason,
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
		});
	});

	pi.on("session_shutdown", async () => {
		refreshTimer?.stop();
		refreshTimer = undefined;
		controller = undefined;
	});
}
