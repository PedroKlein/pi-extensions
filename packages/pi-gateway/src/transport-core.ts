/**
 * Harness-agnostic gateway request transport.
 *
 * Why this exists: both pi and oh-my-pi send `model.id` verbatim as the wire
 * model name — every builtin transport does `model: model.id`. A neutral alias
 * like `heavy-1` is not a real model name, so a backend rejects it:
 *   "Model name 'heavy-1' is not supported."
 *
 * Fix: the gateway registers its OWN api (`GATEWAY_API`) in the harness's api
 * registry. Gateway models carry `api: GATEWAY_API`, so requests route here. At
 * request time the harness has already resolved the gateway provider's
 * credential into `options.apiKey`; this transport maps the alias id to the
 * real backend model captured at compose time, then DELEGATES to that backend's
 * real transport (via the injected {@link TransportHost.deliver}) with the real
 * Model — real wire name, real baseUrl, native streaming preserved.
 *
 * The harness-specific bits (how to register a custom api, and how to dispatch
 * a real model to its transport) are injected via {@link TransportHost}, so
 * this module has no pi / oh-my-pi imports and unit-tests with fakes.
 */

import type { GatewayRouteTarget } from "./compose.js";
import { GATEWAY_API } from "./config.js";

// Minimal structural types — kept local so this module doesn't couple to a
// specific pi-ai Model/Context/options version.
export type UnknownModel = { id: string; [key: string]: unknown };
export type StreamKind = "stream" | "streamSimple";

/** The api-transport spec handed to the harness for registration. */
export interface GatewayApiSpec {
	api: string;
	stream: (model: UnknownModel, context: unknown, options: unknown) => unknown;
	streamSimple: (model: UnknownModel, context: unknown, options: unknown) => unknown;
}

/** Harness-specific hooks the transport needs. */
export interface TransportHost {
	/** Register the gateway api transport in the harness's api registry. */
	registerApi(spec: GatewayApiSpec, sourceId: string): void;
	/**
	 * Dispatch an already-resolved real model to its backend transport. On pi
	 * this looks up `getApiProvider(realModel.api)`; on oh-my-pi it calls the
	 * top-level `stream`/`streamSimple` (which route custom + builtin apis).
	 */
	deliver(kind: StreamKind, realModel: UnknownModel, context: unknown, options: unknown): unknown;
}

export interface GatewayTransport {
	/** Register the `gateway` api once (idempotent). Used by the pi host, whose
	 * api registry is reachable via a direct `registerApiProvider`. On oh-my-pi
	 * this is a no-op: the custom api is registered through `registerProvider`
	 * (see omp-platform) so it lands in the same bundled pi-ai instance the host
	 * dispatches through, and {@link GatewayTransport.streamSimple} is handed to
	 * that provider config. */
	register(): void;
	/** The routed stream delegate (alias→real swap + deliver). */
	stream(model: UnknownModel, context: unknown, options: unknown): unknown;
	/** The routed streamSimple delegate (alias→real swap + deliver). */
	streamSimple(model: UnknownModel, context: unknown, options: unknown): unknown;
	/** Replace the live alias→target routing map (called on every re-register). */
	setRoutes(targets: Record<string, GatewayRouteTarget>): void;
	/** Number of live routes (test seam). */
	routeCount(): number;
	/** Reset routes + registration flag (test seam). */
	reset(): void;
}

const SOURCE_ID = "pi-gateway";

/**
 * Create a gateway transport bound to a harness host. The returned object owns
 * a live alias→target routing map, replaced wholesale on every re-register so a
 * failover transparently reroutes in-flight aliases without re-registering the
 * api.
 */
export function createGatewayTransport(host: TransportHost): GatewayTransport {
	let routes = new Map<string, GatewayRouteTarget>();
	let registered = false;

	function delegate(kind: StreamKind) {
		return (model: UnknownModel, context: unknown, options: unknown): unknown => {
			const target = routes.get(model.id);
			if (!target) {
				throw new Error(
					`gateway: no route for '${model.id}' — the alias set is stale; run /gateway reload`,
				);
			}
			// Forward the real Model verbatim, pinning the wire id/api/baseUrl. The
			// real model already carries these, but we set them explicitly so a
			// stale or partially-copied capture can never send the alias id.
			const realModel: UnknownModel = {
				...(target.realModel as Record<string, unknown>),
				id: target.realModelId,
				api: target.realApi,
				baseUrl: target.realBaseUrl,
			};
			return host.deliver(kind, realModel, context, options);
		};
	}

	return {
		register() {
			if (registered) return;
			host.registerApi(
				{ api: GATEWAY_API, stream: delegate("stream"), streamSimple: delegate("streamSimple") },
				SOURCE_ID,
			);
			registered = true;
		},
		stream: delegate("stream"),
		streamSimple: delegate("streamSimple"),
		setRoutes(targets) {
			routes = new Map(Object.entries(targets));
		},
		routeCount() {
			return routes.size;
		},
		reset() {
			routes = new Map();
			registered = false;
		},
	};
}
