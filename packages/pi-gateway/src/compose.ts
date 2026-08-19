/**
 * Model composer.
 *
 * Pure function: given a fully-resolved backend list + gateway state (which
 * marks some backends unhealthy) + a fallback chain, produce the list of
 * gateway model entries to pass to `pi.registerProvider("gateway", ...)`.
 *
 * The composer emits **family-neutral** aliases: one entry per tier slot in ID
 * form `<slot>-N`, routing to the first healthy backend in `fallbackChain` that
 * has that tier. Examples: `heavy-1`, `medium-1`, `light-1`.
 *
 * Each entry is registered with `api: GATEWAY_API` (see transport.ts) so pi
 * routes its requests to the gateway transport, which maps the alias to the
 * real backend model and delegates. The composer also returns a `targets` map
 * (alias id → real backend model/api/baseUrl) that the session publishes to
 * that transport.
 *
 * Auth is NOT baked per-model. In pi >= 0.84 a provider is only "configured"
 * (selectable in the picker, and its per-request auth resolves) when it has a
 * provider-level `apiKey`; the session registers one for the effective backend.
 *
 * Purity: the composer takes fully-resolved inputs only. No filesystem, no
 * modelRegistry calls. That makes it trivially unit-testable and lets the
 * session_start handler decide when to invoke it.
 */

import {
	DEFAULT_CAP_STATUS_CODES,
	GATEWAY_API,
	TIER_SLOTS,
	type AliasesConfig,
	type TierSlot,
} from "./config.js";
import type { ResolvedBackend } from "./resolver.js";
import type { GatewayState } from "./state.js";

// Capability fields the composer copies from real Model<Api> instances.
// Kept as unknown to stay decoupled from pi's Model type version.
const CAPABILITY_FIELDS = [
	"contextWindow",
	"cost",
	"thinkingLevelMap",
	"compat",
	"input",
	"maxTokens",
	"reasoning",
	"name",
] as const;

/**
 * Shape emitted for pi.registerProvider("gateway", { models: [...] }).
 *
 * Auth is NOT baked per-model. In pi >= 0.84 a provider is only "configured"
 * (and therefore selectable in the model picker) when it has a provider-level
 * `apiKey`/`oauth`; per-model `Authorization` headers are ignored once provider
 * auth resolves. So the session registers a single provider-level `apiKey` for
 * the effective backend and lets pi's native transport apply it. Each entry
 * still carries `baseUrl`/`api` (per-model overrides) identifying where it
 * routes; the transport is resolved from the global api registry by `api`.
 */
export interface GatewayModelEntry {
	id: string;
	name: string;
	baseUrl?: string;
	api?: string;
	// Every capability field copied verbatim from the underlying real model.
	[key: string]: unknown;
}

/**
 * Delegation target for one alias. The gateway transport (transport.ts) uses
 * this to route a request for alias `id` to the real backend model: it swaps in
 * `realModel` (with the real wire `id`, `api`, and `baseUrl`) and delegates to
 * that api's real transport. Captured at compose time from the live registry.
 */
export interface GatewayRouteTarget {
	/** Backend/provider name used for failover attribution and retry-loop bounds. */
	backendName?: string;
	realApi: string;
	realModelId: string;
	realBaseUrl: string;
	/** The full real Model<Api> object, forwarded verbatim to the real provider. */
	realModel: unknown;
	/** The registered backend provider. Routing through it preserves provider-specific transports. */
	realProvider?: {
		stream(model: unknown, context: unknown, options: unknown): unknown;
		streamSimple(model: unknown, context: unknown, options: unknown): unknown;
	};
	/** Backend auth resolved at registration time, including provider-specific headers and env. */
	realAuth?: {
		auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
		env?: Record<string, string>;
	};
}

export interface ComposeInput {
	fallbackChain: readonly string[];
	backends: readonly ResolvedBackend[];
	state: GatewayState;
	/**
	 * Called once per backend during compose; returns a Bearer token
	 * (already resolved). Typically wraps `getApiKeyForProvider(backend)`.
	 * Return undefined to skip a backend that has no valid credentials.
	 */
	resolveApiKey: (backend: ResolvedBackend) => string | undefined;
	/** Optional "now" for testable TTL/expiry checks. */
	now?: () => Date;
}

export interface ComposeWarning {
	kind: "no-healthy-backend-for-tier" | "backend-skipped-no-auth" | "backend-skipped-unknown-in-chain";
	tierSlot?: TierSlot;
	backend?: string;
	message: string;
}

export interface ComposeResult {
	models: GatewayModelEntry[];
	warnings: ComposeWarning[];
	/**
	 * Map of emitted alias id (e.g. `heavy-2`) → the backend name it actually
	 * routed to at compose time. Cap attribution (detect.ts) uses this instead
	 * of parsing the alias name, since indexed aliases are backend-agnostic and
	 * routing depends on live health.
	 */
	routing: Record<string, string>;
	/**
	 * Map of emitted alias id → delegation target. Passed to the gateway
	 * transport so it can map the alias to the real backend model at request
	 * time. Keyed identically to `routing`.
	 */
	targets: Record<string, GatewayRouteTarget>;
}

/**
 * Build a provider-agnostic alias catalogue for extension-load time, before a
 * session context (and therefore the live model registry) exists. The full
 * backend metadata and credential replace these placeholders in session_start.
 */
export function composeBootstrapModels(aliases: AliasesConfig): GatewayModelEntry[] {
	const orderedNames = [
		...aliases.fallbackChain,
		...Object.keys(aliases.backends).filter((name) => !aliases.fallbackChain.includes(name)),
	];
	const models: GatewayModelEntry[] = [];

	for (const tier of TIER_SLOTS) {
		let count = 0;
		for (const name of orderedNames) {
			const declared = aliases.backends[name]?.tiers[tier];
			if (declared && declared.length > 0) {
				count = declared.length;
				break;
			}
		}
		for (let index = 1; index <= count; index++) {
			const id = `${tier}-${index}`;
			models.push({
				id,
				name: `${id} (gateway bootstrap)`,
				api: GATEWAY_API,
				baseUrl: "https://pi-gateway.invalid",
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			});
		}
	}

	return models;
}

/**
 * Whether the backend is unhealthy per the state's TTL. Expired entries are
 * treated as healthy — the composer never mutates state; the caller (P4)
 * sweeps expiries and re-composes.
 */
export function isBackendUnhealthy(
	name: string,
	state: GatewayState,
	now: Date = new Date(),
): boolean {
	const entry = state.unhealthyUntil[name];
	if (!entry) return false;
	const untilMs = Date.parse(entry.until);
	if (Number.isNaN(untilMs)) return false;
	return untilMs > now.getTime();
}

/**
 * Compose the final gateway model list.
 */
export function composeGatewayModels(input: ComposeInput): ComposeResult {
	const now = input.now ? input.now() : new Date();
	const warnings: ComposeWarning[] = [];
	const models: GatewayModelEntry[] = [];
	const routing: Record<string, string> = {};
	const targets: Record<string, GatewayRouteTarget> = {};

	// Index backends by name for chain lookup.
	const byName = new Map<string, ResolvedBackend>();
	for (const b of input.backends) byName.set(b.name, b);

	// Resolve the effective fallback chain honoring per-state override.
	const effectiveChain = input.state.fallbackChainOverride ?? input.fallbackChain;
	// Also honor activeBackendOverride: put it first, then the chain, deduped.
	const active = input.state.activeBackendOverride;
	const orderedNames: string[] = [];
	if (active) orderedNames.push(active);
	for (const n of effectiveChain) if (!orderedNames.includes(n)) orderedNames.push(n);
	// Any backend not in the chain still contributes family-pinned aliases.
	for (const b of input.backends) if (!orderedNames.includes(b.name)) orderedNames.push(b.name);

	// Cache auth per backend (resolveApiKey may be a live call).
	const authByBackend = new Map<string, string | undefined>();
	for (const b of input.backends) {
		try {
			authByBackend.set(b.name, input.resolveApiKey(b));
		} catch (err) {
			warnings.push({
				kind: "backend-skipped-no-auth",
				backend: b.name,
				message: `resolveApiKey failed for backend '${b.name}': ${(err as Error).message}`,
			});
			authByBackend.set(b.name, undefined);
		}
	}

	// Warn about chain entries that don't resolve to a known backend.
	for (const name of input.state.fallbackChainOverride ?? input.fallbackChain) {
		if (!byName.has(name)) {
			warnings.push({
				kind: "backend-skipped-unknown-in-chain",
				backend: name,
				message: `fallback chain references unknown backend '${name}' — skipping`,
			});
		}
	}

	// Indexed neutral aliases: `<tier>-<N>` (1-based). For each tier, pick the
	// first HEALTHY backend in the effective chain that declares that tier and
	// has a valid token, then emit one alias per model in that backend's ordered
	// tier list. Diversity lives WITHIN the picked backend (heavy-1, heavy-2,
	// ...). Failover is inherent: when the primary backend is unhealthy, the
	// picker walks to the next backend and indexes into ITS list (t4 semantics).
	for (const tierSlot of TIER_SLOTS) {
		// (a) Canonical alias count K: the number of indexed aliases for this tier
		// is defined by the FIRST backend in the effective chain that declares the
		// tier, IGNORING health. This makes the alias set (heavy-1..heavy-K) stable
		// across cap transitions — a caller pinned to `heavy-2` never sees it
		// vanish when the primary backend caps.
		let canonicalCount = 0;
		for (const name of orderedNames) {
			const b = byName.get(name);
			const tier = b?.tiers.get(tierSlot);
			if (tier && tier.models.length > 0) {
				canonicalCount = tier.models.length;
				break;
			}
		}
		if (canonicalCount === 0) continue; // tier declared by no backend

		// (b) Routing backend: the first HEALTHY backend with a valid token that
		// declares the tier. This is where requests actually go.
		let picked: { backend: ResolvedBackend; token: string } | undefined;
		for (const name of orderedNames) {
			const b = byName.get(name);
			if (!b) continue;
			if (isBackendUnhealthy(name, input.state, now)) continue;
			const tier = b.tiers.get(tierSlot);
			if (!tier || tier.models.length === 0) continue;
			const token = authByBackend.get(name);
			if (!token) continue;
			picked = { backend: b, token };
			break;
		}
		if (!picked) {
			warnings.push({
				kind: "no-healthy-backend-for-tier",
				tierSlot,
				message: `no healthy backend for tier '${tierSlot}' — neutral aliases '${tierSlot}-*' omitted`,
			});
			continue;
		}

		// (c) Emit heavy-1..heavy-K. Each index routes into the picked backend's
		// list, CLAMPED to its length — when the router has fewer models than K
		// (failover to a smaller backend), high indices reuse its last/best model.
		// Diversity is best-effort; availability wins.
		const tier = picked.backend.tiers.get(tierSlot);
		if (!tier) continue;
		for (let n = 1; n <= canonicalCount; n++) {
			const idx = Math.min(n, tier.models.length) - 1;
			const id = `${tierSlot}-${n}`;
			const { entry, target } = makeEntry(id, picked.backend, tier.models[idx]);
			models.push(entry);
			routing[id] = picked.backend.name;
			targets[id] = target;
		}
	}

	return { models, warnings, routing, targets };
}

function makeEntry(
	id: string,
	backend: ResolvedBackend,
	model: { realModelId: string; realModel: unknown },
): { entry: GatewayModelEntry; target: GatewayRouteTarget } {
	const real = model.realModel as Record<string, unknown> | undefined;

	// Prefer per-real-model baseUrl/api; fall back to backend-level.
	const realBaseUrl = (real?.baseUrl as string | undefined) ?? backend.baseUrl ?? "";
	const realApi = (real?.api as string | undefined) ?? backend.api ?? "";

	const entry: GatewayModelEntry = {
		id,
		name: `${id} → ${backend.name}/${model.realModelId}`,
		// The registered model routes through the gateway transport, NOT the real
		// api: pi would otherwise send the alias id (`heavy-1`) as the wire model
		// name and the backend would reject it. The transport swaps in the real
		// model. baseUrl is still the real backend URL so pi's custom-model
		// validation (which rejects an empty baseUrl) passes.
		api: GATEWAY_API,
		baseUrl: realBaseUrl,
	};

	for (const field of CAPABILITY_FIELDS) {
		if (real && real[field] !== undefined) {
			(entry as Record<string, unknown>)[field] = real[field];
		}
	}
	entry.name = `${typeof real?.name === "string" ? real.name : model.realModelId} (${backend.name})`;

	const target: GatewayRouteTarget = {
		backendName: backend.name,
		realApi,
		realModelId: model.realModelId,
		realBaseUrl,
		realModel: model.realModel,
	};
	return { entry, target };
}

// Also export the default cap-status list so the composer package surface is complete.
export { DEFAULT_CAP_STATUS_CODES };
