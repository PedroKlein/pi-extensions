/**
 * pi-gateway session wiring.
 *
 * Reads aliases.json + gateway-state.json, resolves backends, composes the
 * gateway model list, and registers it as the "gateway" provider on
 * session_start.
 *
 * This module is pure business logic — no direct ExtensionAPI dependency —
 * so it can be unit-tested with a fake `pi` and a fake `ctx`.
 */

import type { AliasesConfig } from "./config.js";
import type { GatewayState } from "./state.js";
import { composeGatewayModels, type ComposeWarning, type GatewayModelEntry } from "./compose.js";
import { resolveBackends, type ResolverModelRegistry, type ResolverWarning } from "./resolver.js";

export const GATEWAY_PROVIDER_NAME = "gateway";

export interface GatewayProviderConfig {
	models: GatewayModelEntry[];
	api?: string;
	baseUrl?: string;
	/**
	 * Provider-level credential. Required for the "gateway" provider to count as
	 * "configured" (and thus be selectable in pi's model picker). Already escaped
	 * for pi's config-value resolver via {@link escapeConfigValue}.
	 */
	apiKey?: string;
}

export interface RegisterFn {
	(name: string, config: GatewayProviderConfig): void;
}

/**
 * Escape an already-resolved secret so pi's config-value resolver returns it
 * verbatim. pi treats a provider `apiKey` as a config value: `$VAR`/`${VAR}`
 * interpolate and a leading `!command` executes. We double every `$` (the
 * resolver collapses `$$` -> `$`) and neutralize a leading `!` by writing it as
 * `$!` (which the resolver collapses to `!`). A mid-string `!` is already
 * literal. This keeps opaque bearer tokens AND JSON service keys intact.
 */
export function escapeConfigValue(value: string): string {
	const dollarEscaped = value.replace(/\$/g, "$$$$"); // each $ -> $$
	return dollarEscaped.startsWith("!") ? `$${dollarEscaped}` : dollarEscaped;
}

export interface NotifyFn {
	(message: string, type?: "info" | "warning" | "error"): void;
}

export interface RegistryLike extends ResolverModelRegistry {
	getApiKeyForProvider(name: string): Promise<string | undefined>;
}

export interface RegisterGatewayInput {
	aliases: AliasesConfig;
	state: GatewayState;
	registry: RegistryLike;
	register: RegisterFn;
	notify?: NotifyFn;
	/** Testable clock. */
	now?: () => Date;
}

export interface RegisterGatewayResult {
	modelsRegistered: number;
	resolverWarnings: readonly ResolverWarning[];
	composeWarnings: readonly ComposeWarning[];
	/** alias id → backend name, from the compose step. Used for cap attribution. */
	routing: Record<string, string>;
}

/**
 * The full "read config → resolve → compose → register" pipeline. Called
 * once at session_start and again by P4 on health-state changes and by P6
 * on periodic OAuth refresh.
 */
export async function registerGatewayProvider(
	input: RegisterGatewayInput,
): Promise<RegisterGatewayResult> {
	const { aliases, state, registry, register, notify } = input;

	// 1. Resolve every backend against the live registry.
	const { backends, warnings: resolverWarnings } = resolveBackends(aliases, registry);

	// 2. Pre-fetch a live Bearer token per backend so the composer is sync.
	const tokenByBackend = new Map<string, string>();
	for (const b of backends) {
		try {
			const token = await registry.getApiKeyForProvider(b.name);
			if (token) tokenByBackend.set(b.name, token);
		} catch {
			// Composer will emit a warning per missing token.
		}
	}

	// 3. Compose.
	const { models, warnings: composeWarnings, routing } = composeGatewayModels({
		fallbackChain: aliases.fallbackChain,
		backends,
		state,
		resolveApiKey: (b) => tokenByBackend.get(b.name),
		now: input.now,
	});

	// 4. Determine the effective backend and register with PROVIDER-LEVEL auth.
	//
	// In pi >= 0.84 a provider is only "configured" (selectable in the picker,
	// and its per-request auth resolves) when it has a provider-level apiKey/oauth.
	// A single provider carries a single credential, so all emitted aliases must
	// share one backend. Health is per-backend, so neutral aliases normally all
	// route to the same backend. A disjoint-tier config can yield >1 backend; in
	// that case we serve the primary backend's aliases and warn about the rest.
	const byName = new Map(backends.map((b) => [b.name, b]));
	const usedBackends = new Set(Object.values(routing));
	let modelsToRegister = models;
	let effective: string | undefined = [...usedBackends][0];
	const multiBackendWarnings: string[] = [];
	if (usedBackends.size > 1) {
		const order = state.activeBackendOverride
			? [state.activeBackendOverride, ...(state.fallbackChainOverride ?? aliases.fallbackChain)]
			: (state.fallbackChainOverride ?? aliases.fallbackChain);
		effective = order.find((n) => usedBackends.has(n)) ?? [...usedBackends][0];
		modelsToRegister = models.filter((m) => routing[m.id] === effective);
		const omitted = [...usedBackends].filter((n) => n !== effective);
		multiBackendWarnings.push(
			`aliases span multiple backends (${[...usedBackends].join(", ")}); a single gateway provider carries one credential, so only '${effective}' is served. Omitted (${omitted.join(", ")}) — reorder the fallback chain or force a backend to switch.`,
		);
	}

	const token = effective ? tokenByBackend.get(effective) : undefined;
	const eb = effective ? byName.get(effective) : undefined;
	const config: GatewayProviderConfig = { models: modelsToRegister };
	if (token) config.apiKey = escapeConfigValue(token);
	if (eb?.api) config.api = eb.api;
	if (eb?.baseUrl) config.baseUrl = eb.baseUrl;

	register(GATEWAY_PROVIDER_NAME, config);

	// 5. Surface warnings to the user.
	if (notify) {
		for (const w of resolverWarnings) notify(`[gateway] ${w.message}`, "warning");
		for (const w of composeWarnings) notify(`[gateway] ${w.message}`, "warning");
		for (const m of multiBackendWarnings) notify(`[gateway] ${m}`, "warning");
		if (modelsToRegister.length > 0 && !token) {
			notify(
				`[gateway] no credential resolved for backend '${effective}' — gateway aliases will not be selectable until it is authenticated.`,
				"warning",
			);
		}
	}

	return {
		modelsRegistered: modelsToRegister.length,
		resolverWarnings,
		composeWarnings,
		routing,
	};
}
