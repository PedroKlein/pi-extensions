/**
 * Model composer.
 *
 * Pure function: given a fully-resolved backend list + gateway state (which
 * marks some backends unhealthy) + a fallback chain, produce the list of
 * gateway model entries to pass to `pi.registerProvider("gateway", ...)`.
 *
 * The composer emits two shapes of alias:
 *
 * 1. **Family-neutral** — one entry per tier slot in ID form `<slot>-1`,
 *    routing to the first healthy backend in `fallbackChain` that has that
 *    tier. Examples: `heavy-1`, `medium-1`, `light-1`.
 *
 * 2. **Family-pinned** — one entry per `(backend, tierSlot)`, in ID form
 *    `<slot>-<backend-short>-1`. Routes only to that specific backend even
 *    when the backend is unhealthy (escape hatch for callers who don't want
 *    transparent failover). Examples: `heavy-hai-1`, `heavy-copilot-1`.
 *
 * Auth: each emitted entry carries `headers.Authorization = "Bearer <token>"`
 * where `<token>` is provided by the caller via `resolveApiKey`. Callers
 * typically wire this to `ctx.modelRegistry.getApiKeyForProvider(backend)`.
 *
 * Purity: the composer takes fully-resolved inputs only. No filesystem, no
 * modelRegistry calls. That makes it trivially unit-testable and lets the
 * session_start handler decide when to invoke it.
 */

import { DEFAULT_CAP_STATUS_CODES, TIER_SLOTS, type TierSlot } from "./config.js";
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
			models.push(makeEntry(id, picked.backend, tier.models[idx]));
			routing[id] = picked.backend.name;
		}
	}

	return { models, warnings, routing };
}

function makeEntry(
	id: string,
	backend: ResolvedBackend,
	model: { realModelId: string; realModel: unknown },
): GatewayModelEntry {
	const real = model.realModel as Record<string, unknown> | undefined;

	const entry: GatewayModelEntry = {
		id,
		name: `${id} → ${backend.name}/${model.realModelId}`,
	};

	// Prefer per-real-model baseUrl/api; fall back to backend-level.
	entry.baseUrl = (real?.baseUrl as string | undefined) ?? backend.baseUrl;
	entry.api = (real?.api as string | undefined) ?? backend.api;

	for (const field of CAPABILITY_FIELDS) {
		if (real && real[field] !== undefined) {
			(entry as Record<string, unknown>)[field] = real[field];
		}
	}
	return entry;
}

// Also export the default cap-status list so the composer package surface is complete.
export { DEFAULT_CAP_STATUS_CODES };
