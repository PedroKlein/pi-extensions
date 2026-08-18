/**
 * oh-my-pi (omp) platform adapters.
 *
 * Builds the {@link GatewayPlatform} for oh-my-pi:
 *
 *  - Transport: registers the `gateway` custom api via `registerCustomApi`, and
 *    delegates a routed request to the real backend by calling oh-my-pi's
 *    top-level `stream`/`streamSimple`, which route both custom apis (e.g.
 *    sap-ai-core, registered via `registerProvider` → `registerCustomApi`) and
 *    builtin apis. Since the swapped-in real model carries the real `api`, this
 *    is exactly what oh-my-pi would dispatch natively — no recursion into the
 *    `gateway` api.
 *
 *  - Register: maps the neutral {@link GatewayProviderConfig} onto oh-my-pi's
 *    `registerProvider(name, { api, baseUrl, apiKey, models })`. oh-my-pi has no
 *    per-model baseUrl and requires a provider-level one when defining models;
 *    all registered aliases share the single effective backend, so its baseUrl
 *    applies. The credential is passed literally (oh-my-pi does not use pi's
 *    config-value $/! escaping).
 */

import { registerCustomApi, stream as ompStream, streamSimple as ompStreamSimple } from "@oh-my-pi/pi-ai";

import type { GatewayModelEntry } from "./compose.js";
import { GATEWAY_API } from "./config.js";
import type { RegisterFn } from "./session.js";
import { createGatewayTransport, type GatewayTransport } from "./transport-core.js";

/** oh-my-pi provider config we hand to `registerProvider`. */
export interface OmpProviderConfig {
	api: string;
	baseUrl: string;
	apiKey?: string;
	models: OmpModelConfig[];
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

/** oh-my-pi transport: register a custom api + delegate via top-level dispatch. */
export function createOmpGatewayTransport(): GatewayTransport {
	return createGatewayTransport({
		registerApi(spec, sourceId) {
			registerCustomApi(spec.api, spec.streamSimple as never, sourceId, spec.stream as never);
		},
		deliver(kind, realModel, context, options) {
			return kind === "stream"
				? (ompStream(realModel as never, context as never, options as never) as unknown)
				: (ompStreamSimple(realModel as never, context as never, options as never) as unknown);
		},
	});
}

/** Build the oh-my-pi register adapter for the gateway provider. */
export function ompRegisterProvider(pi: OmpRegisterApi): RegisterFn {
	return (name, config) => {
		pi.registerProvider(name, {
			api: GATEWAY_API,
			baseUrl: config.baseUrl ?? PLACEHOLDER_BASE_URL,
			// Passed literally — oh-my-pi does not apply pi's config-value escaping.
			...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
			models: toOmpModels(config.models),
		});
	};
}
