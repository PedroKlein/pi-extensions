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

/** Shape emitted for pi.registerProvider("gateway", { models: [...] }). */
export interface GatewayModelEntry {
	id: string;
	name: string;
	baseUrl?: string;
	api?: string;
	headers: Record<string, string>;
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
}

/**
 * Given a backend's registered name, produce a short family suffix used in
 * pinned alias IDs. Examples:
 *   "hai-proxy"      -> "hai"
 *   "github-copilot" -> "copilot"
 *   "sap-ai-core"    -> "sap"
 *   "openai"         -> "openai"
 */
export function backendFamilySuffix(backendName: string): string {
	const parts = backendName.split(/[-_]/).filter(Boolean);
	if (parts.length === 0) return backendName;
	// Walk right-to-left, skipping common generic suffixes.
	const GENERIC = new Set(["proxy", "api", "core", "ai", "llm", "gateway"]);
	for (let i = parts.length - 1; i >= 0; i--) {
		const p = parts[i];
		if (p.length >= 3 && !GENERIC.has(p)) return p;
	}
	return parts[0];
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

	// 1. Family-neutral aliases.
	for (const tierSlot of TIER_SLOTS) {
		let picked: { backend: ResolvedBackend; token: string } | undefined;
		for (const name of orderedNames) {
			const b = byName.get(name);
			if (!b) continue;
			if (isBackendUnhealthy(name, input.state, now)) continue;
			const tier = b.tiers.get(tierSlot);
			if (!tier) continue;
			const token = authByBackend.get(name);
			if (!token) continue;
			picked = { backend: b, token };
			break;
		}
		if (!picked) {
			// Only warn if AT LEAST ONE backend declared this tier — otherwise it's
			// simply "this deployment doesn't use that tier" and silence is right.
			const anyDeclared = input.backends.some((b) => b.tiers.has(tierSlot));
			if (anyDeclared) {
				warnings.push({
					kind: "no-healthy-backend-for-tier",
					tierSlot,
					message: `no healthy backend for tier '${tierSlot}' — neutral alias '${tierSlot}-1' omitted`,
				});
			}
			continue;
		}
		models.push(makeEntry(`${tierSlot}-1`, tierSlot, picked.backend, picked.token));
	}

	// 2. Family-pinned aliases.
	for (const b of input.backends) {
		const suffix = backendFamilySuffix(b.name);
		const token = authByBackend.get(b.name);
		if (!token) continue;
		for (const tierSlot of TIER_SLOTS) {
			const tier = b.tiers.get(tierSlot);
			if (!tier) continue;
			models.push(makeEntry(`${tierSlot}-${suffix}-1`, tierSlot, b, token));
		}
	}

	return { models, warnings };
}

function makeEntry(
	id: string,
	tierSlot: TierSlot,
	backend: ResolvedBackend,
	bearerToken: string,
): GatewayModelEntry {
	const tier = backend.tiers.get(tierSlot);
	if (!tier) throw new Error(`makeEntry: backend ${backend.name} has no tier ${tierSlot}`);
	const real = tier.realModel as Record<string, unknown> | undefined;

	const entry: GatewayModelEntry = {
		id,
		name: `${id} → ${backend.name}/${tier.realModelId}`,
		headers: { Authorization: `Bearer ${bearerToken}` },
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
