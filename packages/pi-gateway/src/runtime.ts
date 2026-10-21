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
import {
	AliasesConfigError,
	loadAliasesConfig,
	parseAliasesConfig,
	type AliasesConfig,
} from "./config.js";
import { GatewayController } from "./controller.js";
import type { GatewayHostApi, GatewayHostContext } from "./host.js";
import { installRefreshTimer, type RefreshTimerHandle } from "./refresh-timer.js";
import { resolveBackends } from "./resolver.js";
import { GATEWAY_PROVIDER_NAME, type RegisterFn, type RegistryLike } from "./session.js";
import {
	emptyState,
	GatewayStateError,
	memoryStateStore,
	parseState,
	type GatewayState,
} from "./state.js";
import type { GatewayTransport } from "./transport-core.js";

export const EXTENSION_NAME = "pi-gateway";

export const ALIASES_PATH =
	process.env.PI_GATEWAY_ALIASES_PATH ?? join(homedir(), ".pi", "agent", "aliases.json");
export const STATE_PATH =
	process.env.PI_GATEWAY_STATE_PATH ?? join(homedir(), ".pi", "agent", "gateway-state.json");

/**
 * Events a host extension uses to own the gateway's config and state instead
 * of aliases.json and gateway-state.json. The host answers `request-config`
 * (and may send `config` again at any time) with `{ aliases, state? }`; the
 * gateway then reports every state change on `state`.
 */
export const CONFIG_EVENT = "pi-gateway:config";
export const REQUEST_CONFIG_EVENT = "pi-gateway:request-config";
export const STATE_EVENT = "pi-gateway:state";

interface HostedConfig {
	aliases: AliasesConfig;
	state: GatewayState;
}

function parseHostedConfig(data: unknown): HostedConfig {
	const { aliases, state } = (data ?? {}) as { aliases?: unknown; state?: unknown };
	return {
		aliases: parseAliasesConfig(JSON.stringify(aliases ?? null), CONFIG_EVENT),
		state: state === undefined ? emptyState() : parseState(state, CONFIG_EVENT),
	};
}

// Two copies of the gateway in one session (a Pi package and a host's bundled
// copy) would both register the provider. The first to load serves it.
const ACTIVE_KEY = Symbol.for("pi-gateway.active-event-buses");

function claimEventBus(events: object | undefined): boolean {
	if (!events) return true;
	const global = globalThis as { [ACTIVE_KEY]?: WeakSet<object> };
	const active = (global[ACTIVE_KEY] ??= new WeakSet());
	if (active.has(events)) return false;
	active.add(events);
	return true;
}

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
	/** The request router used by the harness's registered gateway provider. */
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
	if (!claimEventBus(pi.events)) return;

	let controller: GatewayController | undefined;
	let hosted: HostedConfig | undefined;
	let hostedStore: ReturnType<typeof memoryStateStore> | undefined;
	let refreshTimer: RefreshTimerHandle | undefined;
	let sessionContext: GatewayHostContext | undefined;

	platform.transport.setUsageReporter?.((event) =>
		pi.events?.emit("pi-audit:usage", event),
	);

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
	function registerBootstrap(aliases: AliasesConfig): void {
		const models = composeBootstrapModels(aliases);
		if (models.length > 0) {
			platform.registerProvider(GATEWAY_PROVIDER_NAME, {
				models,
				apiKey: BOOTSTRAP_API_KEY,
				baseUrl: BOOTSTRAP_BASE_URL,
			});
		}
	}

	pi.events?.on(CONFIG_EVENT, (data) => {
		let next: HostedConfig;
		try {
			next = parseHostedConfig(data);
		} catch (err) {
			sessionContext?.ui.notify(`${EXTENSION_NAME}: ${(err as Error).message}`, "error");
			return;
		}
		const aliasesChanged =
			hosted === undefined || JSON.stringify(hosted.aliases) !== JSON.stringify(next.aliases);
		hosted = next;
		if (!sessionContext) {
			registerBootstrap(next.aliases);
			return;
		}
		if (aliasesChanged || !controller || !hostedStore) {
			const ctx = sessionContext;
			buildController(ctx).catch((err: Error) =>
				ctx.ui.notify(`${EXTENSION_NAME}: ${err.message}`, "error"),
			);
			return;
		}
		hostedStore.replace(next.state);
		controller.replaceState(next.state);
	});
	pi.events?.emit(REQUEST_CONFIG_EVENT);

	if (!hosted) {
		try {
			registerBootstrap(loadAliasesConfig(ALIASES_PATH));
		} catch {
			// session_start reports missing/invalid config through the harness UI.
		}
	}

	async function refreshSelectedGatewayModel(ctx: GatewayHostContext): Promise<void> {
		// pi.setModel persists the global default; print-mode subprocesses must be read-only.
		if (ctx.mode === "print") return;
		if (ctx.model?.provider !== GATEWAY_PROVIDER_NAME || !ctx.model.id || !pi.setModel) return;
		const refreshed = (ctx.modelRegistry as { find(provider: string, id: string): unknown }).find(
			GATEWAY_PROVIDER_NAME,
			ctx.model.id,
		);
		if (refreshed) await pi.setModel(refreshed);
	}

	async function buildController(ctx: GatewayHostContext): Promise<void> {
		const aliases = hosted?.aliases ?? loadAliasesConfig(ALIASES_PATH);
		hostedStore = hosted
			? memoryStateStore(hosted.state, (state) => pi.events?.emit(STATE_EVENT, state))
			: undefined;
		const registry: RegistryLike = platform.adaptRegistry
			? platform.adaptRegistry(ctx.modelRegistry)
			: (ctx.modelRegistry as never);
		controller = new GatewayController({
			aliases,
			statePath: STATE_PATH,
			...(hostedStore ? { store: hostedStore } : {}),
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
		platform.transport.setUsageReporter?.(undefined);
		sessionContext = undefined;
	});
}
