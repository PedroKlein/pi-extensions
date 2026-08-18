/**
 * pi (earendil-works) transport host.
 *
 * Instantiates the harness-agnostic {@link createGatewayTransport} with pi's
 * global api registry (`@earendil-works/pi-ai/compat`): `registerApiProvider`
 * to expose the `gateway` api, and `getApiProvider(realApi)` to dispatch a
 * routed request to the real backend transport.
 *
 * Keeps the original module-level API (`registerGatewayTransport`,
 * `setGatewayRoutes`, …) so existing pi wiring and tests are unchanged.
 */

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";

import type { GatewayRouteTarget } from "./compose.js";
import {
	createGatewayTransport,
	type GatewayTransport,
	type StreamKind,
	type UnknownModel,
} from "./transport-core.js";

/** The pi transport host, backed by pi's global api registry. */
export function createPiGatewayTransport(): GatewayTransport {
	return createGatewayTransport({
		registerApi(spec, sourceId) {
			registerApiProvider(
				{
					api: spec.api as never,
					stream: spec.stream as never,
					streamSimple: spec.streamSimple as never,
				},
				sourceId,
			);
		},
		deliver(kind: StreamKind, realModel: UnknownModel, context: unknown, options: unknown) {
			const real = getApiProvider(realModel.api as never);
			if (!real) {
				throw new Error(
					`gateway: backend api '${String(realModel.api)}' is not registered in pi's global ` +
						`api registry (needed to route '${realModel.id}'). A custom-transport provider ` +
						`must call registerApiProvider to expose its api globally.`,
				);
			}
			const fn = kind === "stream" ? real.stream : real.streamSimple;
			return fn(realModel as never, context as never, options as never);
		},
	});
}

// ── Module-level singleton (backward-compatible pi API) ─────────────────────

const transport = createPiGatewayTransport();

/** Replace the live alias→target routing map. Called on every re-register. */
export function setGatewayRoutes(targets: Record<string, GatewayRouteTarget>): void {
	transport.setRoutes(targets);
}

/** Test seam: number of live routes. */
export function gatewayRouteCount(): number {
	return transport.routeCount();
}

/**
 * Register the `gateway` api transport once in pi's global registry. Idempotent
 * — safe to call on every session_start. Must run before the gateway provider
 * is registered so pi can resolve the api when a gateway model is selected.
 */
export function registerGatewayTransport(): void {
	transport.register();
}

/** Test-only: reset routes + registration flag. */
export function _resetGatewayTransportForTests(): void {
	transport.reset();
}
