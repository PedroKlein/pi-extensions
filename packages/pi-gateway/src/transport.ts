/**
 * Gateway request transport.
 *
 * Why this exists: pi sends `model.id` verbatim as the wire model name — every
 * builtin transport does `model: model.id`. A neutral alias like `heavy-1` is
 * not a real model name, so registering gateway models under a builtin api (or
 * a backend's own api) makes the backend reject the request:
 *   "Model name 'heavy-1' is not supported."
 *
 * Fix: the gateway registers its OWN api (`GATEWAY_API`) in pi's global api
 * registry. Gateway models carry `api: GATEWAY_API`, so pi routes their
 * requests here. At request time pi has already resolved the gateway provider's
 * credential into `options.apiKey`; this transport maps the alias id to the
 * real backend model captured at compose time, then DELEGATES to that backend's
 * real transport (looked up in the same global registry) with the real Model —
 * real wire name, real baseUrl, native streaming preserved. The real transport
 * consumes `options.apiKey`/headers exactly as for a direct request (bearer for
 * hai-proxy, service-key JSON for SAP AI Core).
 *
 * This keeps the alias id stable and picker-visible while sending the correct
 * wire model name to the backend.
 */

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";

import type { GatewayRouteTarget } from "./compose.js";
import { GATEWAY_API } from "./config.js";

// Live alias id → delegation target. Replaced wholesale on every re-register
// (failover changes which backend each alias resolves to). The transport reads
// this at request time, so a re-register transparently reroutes in-flight
// aliases without re-registering the api.
let routes = new Map<string, GatewayRouteTarget>();
let registered = false;

/** Replace the live alias→target routing map. Called on every re-register. */
export function setGatewayRoutes(targets: Record<string, GatewayRouteTarget>): void {
	routes = new Map(Object.entries(targets));
}

/** Test seam: number of live routes. */
export function gatewayRouteCount(): number {
	return routes.size;
}

// Minimal structural types — kept local so this module doesn't couple to a
// specific pi-ai Model/Context/options version.
type UnknownModel = { id: string; [key: string]: unknown };
type StreamKind = "stream" | "streamSimple";

function delegate(kind: StreamKind) {
	return (model: UnknownModel, context: unknown, options: unknown): unknown => {
		const target = routes.get(model.id);
		if (!target) {
			throw new Error(
				`gateway: no route for '${model.id}' — the alias set is stale; run /gateway reload`,
			);
		}
		const real = getApiProvider(target.realApi as never);
		if (!real) {
			throw new Error(
				`gateway: backend api '${target.realApi}' is not registered in pi's global api ` +
					`registry (needed to route '${model.id}'). A custom-transport provider must ` +
					`call registerApiProvider to expose its api globally.`,
			);
		}
		// Forward the real Model verbatim, pinning the wire id/api/baseUrl. The
		// real model already carries these, but we set them explicitly so a stale
		// or partially-copied capture can never send the alias id on the wire.
		const realModel = {
			...(target.realModel as Record<string, unknown>),
			id: target.realModelId,
			api: target.realApi,
			baseUrl: target.realBaseUrl,
		};
		const fn = kind === "stream" ? real.stream : real.streamSimple;
		return fn(realModel as never, context as never, options as never);
	};
}

/**
 * Register the `gateway` api transport once in pi's global registry. Idempotent
 * — safe to call on every session_start. Must run before the gateway provider
 * is registered so pi can resolve the api when a gateway model is selected.
 */
export function registerGatewayTransport(): void {
	if (registered) return;
	registerApiProvider(
		{
			api: GATEWAY_API as never,
			stream: delegate("stream") as never,
			streamSimple: delegate("streamSimple") as never,
		},
		"pi-gateway",
	);
	registered = true;
}

/** Test-only: reset routes + registration flag. */
export function _resetGatewayTransportForTests(): void {
	routes = new Map();
	registered = false;
}
