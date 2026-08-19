/**
 * oh-my-pi (omp) platform adapters.
 *
 * Builds the {@link GatewayPlatform} for oh-my-pi:
 *
 *  - Transport: delegates built-in APIs through oh-my-pi's top-level
 *    `stream`/`streamSimple`. Extension-defined APIs announce their stream
 *    handlers over the shared event bus because OMP loads extensions in an
 *    isolated module graph whose custom-API registry is not the host registry.
 *    Since the swapped-in real model carries the real `api`, neither path
 *    recurses into the `gateway` api.
 *
 *  - Register: maps the neutral {@link GatewayProviderConfig} onto oh-my-pi's
 *    `registerProvider(name, { api, baseUrl, apiKey, models })`. oh-my-pi has no
 *    per-model baseUrl and requires a provider-level one when defining models;
 *    all registered aliases share the single effective backend, so its baseUrl
 *    applies. The credential is passed literally (oh-my-pi does not use pi's
 *    config-value $/! escaping).
 */

import { stream as ompStream, streamSimple as ompStreamSimple } from "@oh-my-pi/pi-ai";

import type { GatewayModelEntry } from "./compose.js";
import { GATEWAY_API } from "./config.js";
import type { RegisterFn, RegistryLike } from "./session.js";
import { createGatewayTransport, type GatewayTransport, type UnknownModel } from "./transport-core.js";

export interface OmpCustomTransport {
	stream?: (model: UnknownModel, context: unknown, options: unknown) => unknown;
	streamSimple: (model: UnknownModel, context: unknown, options: unknown) => unknown;
}

export type OmpCustomTransportLookup = (api: string) => OmpCustomTransport | undefined;

export interface OmpCustomTransportRegistration extends OmpCustomTransport {
	api: string;
}

export const OMP_GATEWAY_REGISTER_TRANSPORT_EVENT = "pi-gateway:register-transport";
export const OMP_GATEWAY_REQUEST_TRANSPORTS_EVENT = "pi-gateway:request-transports";

/** oh-my-pi provider config we hand to `registerProvider`. */
export interface OmpProviderConfig {
	api: string;
	baseUrl: string;
	apiKey?: string;
	models: OmpModelConfig[];
	/**
	 * The routed streamSimple delegate. oh-my-pi's `registerProvider` forwards
	 * this to its *internal* `registerCustomApi`, so the `gateway` api lands in
	 * the same bundled pi-ai instance the host dispatches through (a direct
	 * `registerCustomApi` from the redirected root hits a separate instance and
	 * `getCustomApi` never sees it — the "Unhandled API in mapOptionsForApi"
	 * failure).
	 */
	streamSimple?: (model: UnknownModel, context: unknown, options: unknown) => unknown;
}

/** Structural oh-my-pi ProviderModelConfig (subset we populate). */
export interface OmpModelConfig {
	id: string;
	name: string;
	api: string;
	[key: string]: unknown;
}

/** Minimal oh-my-pi API surface for provider registration. */
export interface OmpRegisterApi {
	registerProvider(name: string, config: OmpProviderConfig): void;
}

/** Fallback base URL when the effective backend didn't report one (kept valid so
 * oh-my-pi's "baseUrl required when defining models" check passes; the transport
 * always pins the real backend's baseUrl at request time). */
const PLACEHOLDER_BASE_URL = "https://pi-gateway.invalid";

/**
 * Convert gateway model entries to oh-my-pi ProviderModelConfig: drop the
 * per-model `baseUrl` (unsupported) and pin `api` to the gateway api so
 * dispatch resolves the gateway transport.
 */
export function toOmpModels(models: GatewayModelEntry[]): OmpModelConfig[] {
	return models.map((m) => {
		const { baseUrl: _baseUrl, ...rest } = m;
		return { ...rest, api: GATEWAY_API } as OmpModelConfig;
	});
}

/**
 * oh-my-pi transport: routes alias→real, using an announced extension transport
 * when present and the top-level `stream`/`streamSimple` for built-in APIs.
 * Registration of the `gateway` custom api does NOT
 * happen here — it goes through `registerProvider` (see {@link ompRegisterProvider})
 * so it reaches the host's bundled pi-ai instance. `register()` is therefore a
 * no-op; the transport only owns the routing map + delegates.
 */
export function createOmpGatewayTransport(
	lookupCustomTransport: OmpCustomTransportLookup = () => undefined,
): GatewayTransport {
	return createGatewayTransport({
		registerApi() {
			/* no-op: registered via registerProvider(streamSimple) instead */
		},
		deliver(kind, realModel, context, options) {
			const custom = lookupCustomTransport(String(realModel.api));
			if (custom) {
				return kind === "stream" && custom.stream
					? custom.stream(realModel, context, options)
					: custom.streamSimple(realModel, context, options);
			}
			return kind === "stream"
				? (ompStream(realModel as never, context as never, options as never) as unknown)
				: (ompStreamSimple(realModel as never, context as never, options as never) as unknown);
		},
	});
}

/**
 * The subset of oh-my-pi's `ModelRegistry` the gateway needs. oh-my-pi's
 * registry surface differs from pi's: it exposes `hasProvider` /
 * `getProviderBaseUrl` rather than pi's `getProvider` /
 * `getRegisteredProviderConfig`.
 */
export interface OmpModelRegistry {
	find(provider: string, modelId: string): unknown | undefined;
	getAll(): Array<{ id: string; provider: string; api?: string }>;
	hasProvider(provider: string): boolean;
	getProviderBaseUrl(provider: string): string | undefined;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/**
 * Adapt oh-my-pi's `ModelRegistry` to the {@link RegistryLike} surface the
 * shared resolver/session expect (written against pi's registry API). pi's
 * registry already implements {@link RegistryLike} structurally, so only
 * oh-my-pi needs this shim.
 *
 *  - `getProvider(name)` → synthesized from `hasProvider(name)`.
 *  - `getRegisteredProviderConfig(name)` → synthesized from
 *    `getProviderBaseUrl(name)` plus the backend's `api` (read off any of its
 *    registered models). The credential is *not* included here — the shared
 *    pipeline resolves it asynchronously via `getApiKeyForProvider`.
 */
export function adaptOmpRegistry(reg: OmpModelRegistry): RegistryLike {
	return {
		find: (provider, modelId) => reg.find(provider, modelId),
		getAll: () => reg.getAll(),
		getProvider: (provider) => (reg.hasProvider(provider) ? { id: provider } : undefined),
		getRegisteredProviderConfig: (provider) => {
			if (!reg.hasProvider(provider) && !reg.getAll().some((m) => m.provider === provider)) {
				return undefined;
			}
			const baseUrl = reg.getProviderBaseUrl(provider);
			const api = reg.getAll().find((m) => m.provider === provider)?.api;
			const cfg: { apiKey?: string; baseUrl?: string; api?: string } = {};
			if (baseUrl !== undefined) cfg.baseUrl = baseUrl;
			if (api !== undefined) cfg.api = api;
			return cfg;
		},
		getApiKeyForProvider: (provider) => reg.getApiKeyForProvider(provider),
	};
}

/** Build the oh-my-pi register adapter for the gateway provider. */
/**
 * Build the oh-my-pi register adapter for the gateway provider. The transport's
 * `streamSimple` delegate is passed as `config.streamSimple` so oh-my-pi
 * registers the `gateway` custom api internally (reachable by `getCustomApi`).
 */
export function ompRegisterProvider(pi: OmpRegisterApi, transport: GatewayTransport): RegisterFn {
	return (name, config) => {
		pi.registerProvider(name, {
			api: GATEWAY_API,
			baseUrl: config.baseUrl ?? PLACEHOLDER_BASE_URL,
			// Passed literally — oh-my-pi does not apply pi's config-value escaping.
			...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
			models: toOmpModels(config.models),
			streamSimple: (model, context, options) => transport.streamSimple(model, context, options),
		});
	};
}
