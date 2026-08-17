/**
 * Backend + real-model resolver.
 *
 * Given a backend name declared in aliases.json, look up its Provider, its
 * registration config (if any), and every real model referenced in its
 * `tiers` map. Returns a normalized `ResolvedBackend` containing everything
 * the composer needs to emit gateway model entries.
 *
 * Design decisions (traceable to {scratchDir}/api-verification.md):
 * - `ctx.modelRegistry.getProvider(name).models` is `[]` at runtime. Model
 *   lookups use `modelRegistry.find(name, modelId)`.
 * - `getRegisteredProviderConfig(name)` returns undefined for built-in
 *   providers (anthropic/openai/google), for some extension-registered
 *   providers (github-copilot, sap-ai-core), and for OAuth providers with
 *   no `apiKey` field. Treat that as `authMode: "resolved"` — the composer
 *   will fetch a live key via `getApiKeyForProvider` at re-register time.
 * - authMode is only used downstream to decide whether P6's periodic-refresh
 *   timer needs to run for this backend. `static` skips it; anything else
 *   participates.
 */

import type {
	AliasesConfig,
	BackendConfig,
	TierSlot,
} from "./config.js";

/** Minimal shape of the modelRegistry surface the resolver depends on. */
export interface ResolverModelRegistry {
	find(provider: string, modelId: string): unknown | undefined;
	getProvider(provider: string): { id: string; name?: string } | undefined;
	getRegisteredProviderConfig(provider: string):
		| { apiKey?: string; baseUrl?: string; api?: string; oauth?: unknown }
		| undefined;
	getAll(): Array<{ id: string; provider: string }>;
}

export type AuthMode = "command" | "env" | "static" | "resolved" | "unknown";

/**
 * The subset of a real Model<Api> the composer copies into gateway models.
 * Left as `unknown` here because different pi versions have wider Model
 * types; the composer treats it as a value bag and forwards it verbatim.
 */
export type RealModel = unknown;

/** A single resolved model within a tier's ordered list. */
export interface ResolvedModel {
	realModelId: string;
	realModel: RealModel;
}

export interface ResolvedTier {
	tierSlot: TierSlot;
	/**
	 * Ordered list of resolved models for this tier. Index N (1-based) maps to
	 * the `<tier>-N` gateway alias. Unresolvable model IDs are dropped (with a
	 * warning) so a partial list still yields usable aliases. Never empty — a
	 * tier whose models all fail to resolve is omitted from the map entirely.
	 */
	models: ResolvedModel[];
}

export interface ResolvedBackend {
	name: string;
	authMode: AuthMode;
	/**
	 * Raw apiKey string as passed to registerProvider (may be a `!command`,
	 * `$ENV_VAR`, or literal). Undefined for built-in providers or those
	 * with no apiKey field visible via getRegisteredProviderConfig.
	 */
	apiKeyRaw: string | undefined;
	/** baseUrl from getRegisteredProviderConfig, if present. Model-level
	 * baseUrl on the resolved Model<Api> takes precedence at compose time. */
	baseUrl: string | undefined;
	/** api type from getRegisteredProviderConfig, if present. Similar caveat. */
	api: string | undefined;
	/** Tier slot → resolved real model. Missing slots are omitted, never null. */
	tiers: ReadonlyMap<TierSlot, ResolvedTier>;
	/** Copy of the backend's config (quotaHint, capStatusCodes, resetSchedule). */
	config: BackendConfig;
}

/** Warning surfaced by the resolver. Callers decide how to surface. */
export interface ResolverWarning {
	kind: "unknown-backend" | "unknown-model";
	backend: string;
	tierSlot?: TierSlot;
	realModelId?: string;
	message: string;
}

export interface ResolveResult {
	backends: readonly ResolvedBackend[];
	warnings: readonly ResolverWarning[];
}

/**
 * Resolve every backend declared in an AliasesConfig against a live
 * modelRegistry. Unknown backends and unknown real models produce warnings
 * (not thrown errors) so that a partial config still yields useful gateway
 * models. The caller (session_start handler) is expected to notify the user
 * about each warning.
 */
export function resolveBackends(
	config: AliasesConfig,
	registry: ResolverModelRegistry,
): ResolveResult {
	const backends: ResolvedBackend[] = [];
	const warnings: ResolverWarning[] = [];

	for (const [name, backendCfg] of Object.entries(config.backends)) {
		const provider = registry.getProvider(name);
		const hasModels = registry.getAll().some((m) => m.provider === name);
		if (!provider && !hasModels) {
			warnings.push({
				kind: "unknown-backend",
				backend: name,
				message: `backend '${name}' is not registered as a pi provider — skipping all its aliases`,
			});
			continue;
		}

		const cfg = registry.getRegisteredProviderConfig(name);
		const apiKeyRaw = cfg?.apiKey;
		const authMode = classifyAuthMode(apiKeyRaw, cfg);

		const tiers = new Map<TierSlot, ResolvedTier>();
		for (const [slotRaw, modelIds] of Object.entries(backendCfg.tiers)) {
			const tierSlot = slotRaw as TierSlot;
			if (!modelIds || modelIds.length === 0) continue;
			const models: ResolvedModel[] = [];
			for (const realModelId of modelIds) {
				const realModel = registry.find(name, realModelId);
				if (!realModel) {
					warnings.push({
						kind: "unknown-model",
						backend: name,
						tierSlot,
						realModelId,
						message: `backend '${name}' tier '${tierSlot}' references unknown real model '${realModelId}' — omitting this alias`,
					});
					continue;
				}
				models.push({ realModelId, realModel });
			}
			// Omit the tier entirely if every model failed to resolve.
			if (models.length > 0) tiers.set(tierSlot, { tierSlot, models });
		}

		backends.push({
			name,
			authMode,
			apiKeyRaw,
			baseUrl: cfg?.baseUrl,
			api: cfg?.api,
			tiers,
			config: backendCfg,
		});
	}

	return { backends, warnings };
}

/**
 * Classify the auth shape of a backend so P6 can decide whether to install a
 * periodic-refresh timer.
 *
 * - `command`: apiKey starts with `!`. Underlying value refreshes when pi
 *   re-runs the command. Gateway snapshots at re-register time.
 * - `env`:     apiKey starts with `$`. Environment-variable interpolation.
 *   Static within a process lifetime; gateway snapshots once.
 * - `static`:  apiKey is a plain literal. No refresh needed ever.
 * - `resolved`: registeredCfg is undefined or has no apiKey. Gateway must
 *   call getApiKeyForProvider at re-register time and periodically after
 *   (OAuth refresh, built-in provider fallback, etc.).
 * - `unknown`: shouldn't happen; guard for future config shapes.
 */
export function classifyAuthMode(
	apiKeyRaw: string | undefined,
	cfg: ResolverModelRegistry extends {
		getRegisteredProviderConfig(name: string): infer C;
	}
		? C
		: { apiKey?: string; oauth?: unknown } | undefined,
): AuthMode {
	if (apiKeyRaw === undefined) {
		// Whether or not an oauth block is present, we need to call
		// getApiKeyForProvider at re-register time — treat both as 'resolved'.
		return "resolved";
	}
	if (typeof apiKeyRaw !== "string") return "unknown";
	if (apiKeyRaw.startsWith("!")) return "command";
	if (apiKeyRaw.startsWith("$")) return "env";
	if (apiKeyRaw.length > 0) return "static";
	return "unknown";
}
