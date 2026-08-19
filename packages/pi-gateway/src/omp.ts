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
 *
 * The incoming `pi` is typed structurally ({@link GatewayHostApi} +
 * {@link OmpRegisterApi}) rather than against `@oh-my-pi/pi-coding-agent`, so
 * this package needs only the lightweight `@oh-my-pi/pi-ai` at build time — the
 * full coding-agent (which drags in @huggingface/transformers, onnxruntime,
 * sharp) is not required just to typecheck the entry.
 */

import type { GatewayHostApi } from "./host.js";
import {
	adaptOmpRegistry,
	createOmpGatewayTransport,
	OMP_GATEWAY_REGISTER_TRANSPORT_EVENT,
	OMP_GATEWAY_REQUEST_TRANSPORTS_EVENT,
	ompRegisterProvider,
	type OmpCustomTransportRegistration,
	type OmpModelRegistry,
	type OmpRegisterApi,
} from "./omp-platform.js";
import { activateGateway, type GatewayPlatform } from "./runtime.js";

export {
	ALIASES_PATH,
	EXTENSION_NAME,
	listBackendModels,
	listRegistryProviders,
	STATE_PATH,
} from "./runtime.js";

export default function (pi: GatewayHostApi & OmpRegisterApi) {
	const customTransports = new Map<string, OmpCustomTransportRegistration>();
	pi.events?.on(OMP_GATEWAY_REGISTER_TRANSPORT_EVENT, (data) => {
		if (!isCustomTransportRegistration(data)) return;
		customTransports.set(data.api, data);
	});
	pi.on("session_start", () => {
		pi.events?.emit(OMP_GATEWAY_REQUEST_TRANSPORTS_EVENT);
	});

	const transport = createOmpGatewayTransport((api) => customTransports.get(api));
	const platform: GatewayPlatform = {
		transport,
		registerProvider: ompRegisterProvider(pi, transport),
		adaptRegistry: (registry) => adaptOmpRegistry(registry as OmpModelRegistry),
	};
	activateGateway(pi, platform);
}

function isCustomTransportRegistration(data: unknown): data is OmpCustomTransportRegistration {
	if (!data || typeof data !== "object") return false;
	const registration = data as Partial<OmpCustomTransportRegistration>;
	return typeof registration.api === "string" && typeof registration.streamSimple === "function";
}
