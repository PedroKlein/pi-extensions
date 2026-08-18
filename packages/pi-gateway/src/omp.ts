/**
 * pi-gateway — oh-my-pi (omp) entry point.
 *
 * oh-my-pi forked pi-mono and uses a different provider/transport surface than
 * pi (earendil-works): `pi.registerProvider(name, config)` with a
 * provider-level `baseUrl`/`apiKey`, and `@oh-my-pi/pi-ai`'s `registerCustomApi`
 * / top-level `stream`/`streamSimple` for custom-api dispatch.
 *
 * This file is the thin oh-my-pi adapter: it builds the oh-my-pi
 * {@link GatewayPlatform} (see ./omp-platform.ts) and hands off to the same
 * shared {@link activateGateway} runtime the pi entry uses.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { createOmpGatewayTransport, ompRegisterProvider, type OmpRegisterApi } from "./omp-platform.js";
import { activateGateway, type GatewayPlatform } from "./runtime.js";

export {
	ALIASES_PATH,
	EXTENSION_NAME,
	listBackendModels,
	listRegistryProviders,
	STATE_PATH,
} from "./runtime.js";

export default function (pi: ExtensionAPI) {
	const platform: GatewayPlatform = {
		transport: createOmpGatewayTransport(),
		registerProvider: ompRegisterProvider(pi as unknown as OmpRegisterApi),
	};
	activateGateway(pi as unknown as Parameters<typeof activateGateway>[0], platform);
}
