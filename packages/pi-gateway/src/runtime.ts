/**
 * Shared gateway runtime — harness-agnostic activation logic.
 *
 * Holds the session_start / message_end / session_shutdown wiring, controller
 * build/rebuild, refresh timer, and command registration. The harness-specific
 * bits (how to register the gateway provider, and the request transport) are
 * supplied via {@link GatewayPlatform}, so both pi and oh-my-pi entry points
 * reuse this identical logic.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { registerGatewayCommand } from "./command.js";
import { composeBootstrapModels } from "./compose.js";
import { AliasesConfigError, loadAliasesConfig } from "./config.js";
import { GatewayController } from "./controller.js";
import type { GatewayHostApi, GatewayHostContext } from "./host.js";
import { installRefreshTimer, type RefreshTimerHandle } from "./refresh-timer.js";
import { resolveBackends } from "./resolver.js";
import { GATEWAY_PROVIDER_NAME, type RegisterFn, type RegistryLike } from "./session.js";
import { GatewayStateError } from "./state.js";
import type { GatewayTransport } from "./transport-core.js";

export const EXTENSION_NAME = "pi-gateway";

export const ALIASES_PATH =
	process.env.PI_GATEWAY_ALIASES_PATH ?? join(homedir(), ".pi", "agent", "aliases.json");
export const STATE_PATH =
	process.env.PI_GATEWAY_STATE_PATH ?? join(homedir(), ".pi", "agent", "gateway-state.json");

const BOOTSTRAP_API_KEY = "gateway-bootstrap";
const BOOTSTRAP_BASE_URL = "https://pi-gateway.invalid";

/** Minimal registry surface for model/provider listing. */
interface ModelListRegistry {
	getAll(): Array<{ id: string; provider: string }>;
}

/** Real model ids registered for a backend (provider), sorted + de-duped. */
export function listBackendModels(registry: unknown, backend: string): string[] {
	const all = (registry as ModelListRegistry).getAll?.() ?? [];
	const ids = new Set<string>();
	for (const m of all) if (m.provider === backend) ids.add(m.id);
	return [...ids].sort();
}

/** All provider names known to the registry, sorted. */
export function listRegistryProviders(registry: unknown): string[] {
	const all = (registry as ModelListRegistry).getAll?.() ?? [];
	const names = new Set<string>();
	for (const m of all) names.add(m.provider);
	return [...names].sort();
}

/** Harness-specific integration the runtime depends on. */
export interface GatewayPlatform {
	/** The request transport (already bound to the harness's api registry). */
	transport: GatewayTransport;
	/** Register (or replace) the gateway provider in the harness. */
	registerProvider: RegisterFn;
	/**
	 * Adapt the host's `ctx.modelRegistry` to the {@link RegistryLike} surface the
	 * shared resolver/session expect. pi's registry already satisfies it, so the
	 * pi entry omits this; oh-my-pi supplies an adapter (its registry exposes a
	 * different method set).
	 */
	adaptRegistry?: (registry: unknown) => RegistryLike;
}

/**
 * Wire the gateway into a harness. Shared by pi.ts and omp.ts.
 */
export function activateGateway(pi: GatewayHostApi, platform: GatewayPlatform): void {
	let controller: GatewayController | undefined;
	let refreshTimer: RefreshTimerHandle | undefined;
	let sessionContext: GatewayHostContext | undefined;

	registerGatewayCommand(pi, {
		getController: () => controller,
		statePath: STATE_PATH,
		aliasesPath: ALIASES_PATH,
		rebuildController: async () => {
			if (!sessionContext) throw new Error("gateway session has not started");
			await buildController(sessionContext);
		},
		listModels: (backend) =>
			sessionContext ? listBackendModels(sessionContext.modelRegistry, backend) : [],
		listProviders: () =>
			sessionContext ? listRegistryProviders(sessionContext.modelRegistry) : [],
	});

	// Startup model selection happens before session_start. Queue a lightweight
	// alias catalogue during extension load so configured gateway/* defaults can
	// resolve; session_start replaces it with fully resolved backend metadata.
	platform.transport.register();
	try {
		const aliases = loadAliasesConfig(ALIASES_PATH);
		const models = composeBootstrapModels(aliases);
		if (models.length > 0) {
			platform.registerProvider(GATEWAY_PROVIDER_NAME, {
				models,
				apiKey: BOOTSTRAP_API_KEY,
				baseUrl: BOOTSTRAP_BASE_URL,
			});
		}
	} catch {
		// session_start reports missing/invalid config through the harness UI.
	}

	async function refreshSelectedGatewayModel(ctx: GatewayHostContext): Promise<void> {
		if (ctx.model?.provider !== GATEWAY_PROVIDER_NAME || !ctx.model.id || !pi.setModel) return;
		const refreshed = (ctx.modelRegistry as { find(provider: string, id: string): unknown }).find(
			GATEWAY_PROVIDER_NAME,
			ctx.model.id,
		);
		if (refreshed) await pi.setModel(refreshed);
	}

	async function buildController(ctx: GatewayHostContext): Promise<void> {
		const aliases = loadAliasesConfig(ALIASES_PATH);
		const registry: RegistryLike = platform.adaptRegistry
			? platform.adaptRegistry(ctx.modelRegistry)
			: (ctx.modelRegistry as never);
		controller = new GatewayController({
			aliases,
			statePath: STATE_PATH,
			registry: registry as never,
			register: platform.registerProvider,
			setRoutes: (targets) => platform.transport.setRoutes(targets),
			onRegistered: () => refreshSelectedGatewayModel(ctx),
			notify: (msg, type) => ctx.ui.notify(msg, type),
		});
		platform.transport.setFailureHandler((failure) =>
			controller ? controller.handleTransportFailure(failure) : Promise.resolve(false),
		);
		await controller.initialize();

		// Install (or re-install) the periodic token-refresh timer.
		refreshTimer?.stop();
		const { backends } = resolveBackends(aliases, registry);
		refreshTimer = installRefreshTimer({
			backends,
			isIdle: () => (ctx.isIdle ? ctx.isIdle() : true),
			onTick: () => controller?.requestReregister(),
		});
	}

	pi.on("session_start", async (_event: unknown, ctx: GatewayHostContext) => {
		sessionContext = ctx;
		// Register the gateway api transport once, before any provider
		// registration, so the harness can resolve `api: "gateway"` when a gateway
		// alias is selected.
		platform.transport.register();
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
				ctx.ui.notify(`${EXTENSION_NAME}: ${(err as Error).message}`, "error");
				return;
			}
			ctx.ui.notify(
				`${EXTENSION_NAME}: unexpected error on session_start: ${(err as Error).message}`,
				"error",
			);
		}

	});

	pi.on("message_end", async (event: { message?: any }, ctx: GatewayHostContext) => {
		if (!controller) return;
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		controller.handleMessageEnd({
			errorStatus: msg.errorStatus,
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
		platform.transport.setFailureHandler(undefined);
		sessionContext = undefined;
	});
}
