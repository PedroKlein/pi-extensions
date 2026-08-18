/**
 * pi-gateway — pi (earendil-works) entry point.
 *
 * Virtual provider that exposes tier aliases (heavy-1, medium-1, light-1, plus
 * family-pinned variants) routing to already-registered pi providers with
 * automatic failover on cap hits.
 *
 * This file is the thin pi adapter: it builds the pi {@link GatewayPlatform}
 * (pi's provider registration + the pi transport host) and hands off to the
 * shared {@link activateGateway} runtime. The oh-my-pi entry point lives in
 * ./omp.ts and reuses the same runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { activateGateway, type GatewayPlatform } from "./runtime.js";
import { escapeConfigValue } from "./session.js";
import { createPiGatewayTransport } from "./transport.js";

// Re-exports kept stable for consumers/tests.
export {
	ALIASES_PATH,
	EXTENSION_NAME,
	listBackendModels,
	listRegistryProviders,
	STATE_PATH,
} from "./runtime.js";

export default function (pi: ExtensionAPI) {
	const platform: GatewayPlatform = {
		transport: createPiGatewayTransport(),
		registerProvider: (name, config) =>
			pi.registerProvider(name, {
				models: config.models,
				// pi treats provider apiKey as a config value ($VAR/${VAR}/!command),
				// so escape the opaque token/JSON service key to survive verbatim.
				...(config.apiKey !== undefined ? { apiKey: escapeConfigValue(config.apiKey) } : {}),
			} as never),
	};
	activateGateway(pi, platform);
}
