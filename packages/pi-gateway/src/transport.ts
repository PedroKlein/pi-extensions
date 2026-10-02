/**
 * pi (earendil-works) transport host.
 *
 * Pi 1.0 registers the gateway's custom stream through `registerProvider`
 * and exposes each backend's composed provider through `ModelRegistry`.
 * Routes therefore dispatch through their captured provider; no process-global
 * API registry is involved.
 */

import { createGatewayTransport, type GatewayTransport } from "./transport-core.js";

export function createPiGatewayTransport(): GatewayTransport {
	return createGatewayTransport({
		deliver(_kind, realModel) {
			throw new Error(
				`gateway: registered provider dispatch is unavailable for '${String(realModel.provider)}/${realModel.id}'`,
			);
		},
	});
}
