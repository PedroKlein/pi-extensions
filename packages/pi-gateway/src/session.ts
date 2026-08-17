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

export interface RegisterFn {
	(name: string, config: { models: GatewayModelEntry[]; api?: string; baseUrl?: string }): void;
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
	const { models, warnings: composeWarnings } = composeGatewayModels({
		fallbackChain: aliases.fallbackChain,
		backends,
		state,
		resolveApiKey: (b) => tokenByBackend.get(b.name),
		now: input.now,
	});

	// 4. Register (single call).
	register(GATEWAY_PROVIDER_NAME, { models });

	// 5. Surface warnings to the user.
	if (notify) {
		for (const w of resolverWarnings) notify(`[gateway] ${w.message}`, "warning");
		for (const w of composeWarnings) notify(`[gateway] ${w.message}`, "warning");
	}

	return {
		modelsRegistered: models.length,
		resolverWarnings,
		composeWarnings,
	};
}
