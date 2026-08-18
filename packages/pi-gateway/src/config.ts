/**
 * aliases.json schema, loader, validator.
 *
 * aliases.json is a per-machine, gitignored file at ~/.pi/agent/aliases.json
 * that declares tier aliases (heavy / medium / light / xlight / minimal) and
 * routes them to real backend models registered by other pi providers.
 *
 * IMPORTANT: aliases.json must NEVER duplicate provider settings (baseUrl,
 * apiKey, api). Those live on already-registered pi providers; the gateway
 * reads them via ctx.modelRegistry at re-register time.
 *
 * Shape (see AliasesConfig for full types):
 *   {
 *     "fallbackChain": ["openrouter", "groq"],
 *     "backends": {
 *       "openrouter": {
 *         "resetSchedule": "utc-midnight",
 *         "tiers": {
 *           "heavy":  ["anthropic/claude-opus-4", "openai/gpt-5"],
 *           "medium": "anthropic/claude-sonnet-4",
 *           "light":  "openai/gpt-5-mini"
 *         },
 *         "quotaHint": "daily-eur-cap",
 *         "capStatusCodes": [402, 429]
 *       }
 *     }
 *   }
 */

import { readFileSync } from "node:fs";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Named reset-schedule presets. Extendable in future without breaking configs. */
export const RESET_SCHEDULES = ["utc-midnight", "utc-monthly-1st", "utc-hourly"] as const;export type ResetSchedule = (typeof RESET_SCHEDULES)[number];

/** Named quotaHint enrichers shipped in v1. Extendable in future. */
export const QUOTA_HINTS = ["daily-eur-cap"] as const;

/**
 * The api id the gateway registers in pi's global api registry. Gateway models
 * are registered with `api: GATEWAY_API` so pi routes their requests to the
 * gateway transport (see transport.ts), which maps the neutral alias id to the
 * real backend model and delegates to that backend's real transport. This
 * indirection is required because pi sends `model.id` verbatim as the wire
 * model name — a neutral alias like `heavy-1` is not a real model name.
 */
export const GATEWAY_API = "gateway";
export type QuotaHint = (typeof QUOTA_HINTS)[number];

/** Neutral tier slots. Family-pinned aliases are auto-derived per backend. */
export const TIER_SLOTS = ["heavy", "medium", "light", "xlight", "minimal"] as const;
export type TierSlot = (typeof TIER_SLOTS)[number];

/** Default HTTP status codes that indicate a cap hit. */
export const DEFAULT_CAP_STATUS_CODES: readonly number[] = [402, 429];

// ---------- TypeBox schemas ----------

const TTierSlot = Type.Union(TIER_SLOTS.map((v) => Type.Literal(v)));
const TResetSchedule = Type.Union(RESET_SCHEDULES.map((v) => Type.Literal(v)));
const TQuotaHint = Type.Union(QUOTA_HINTS.map((v) => Type.Literal(v)));

// Tiers is an open-shape object where each key is a known TierSlot and each
// value is either a non-empty string (single model) or a non-empty ordered
// list of model IDs (indexed diversity: heavy-1, heavy-2, ...). All slots are
// optional. Extra slots are rejected via additionalProperties: false.
// Empty arrays are rejected by the explicit semantic check in
// parseAliasesConfig (cause="semantic"), so no minItems here — that keeps the
// error cause stable and the message specific to the offending tier slot.
const TTierValue = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Array(Type.String({ minLength: 1 })),
]);
const tierPropSchemas: Record<string, ReturnType<typeof Type.Optional>> = {};
for (const slot of TIER_SLOTS) {
	tierPropSchemas[slot] = Type.Optional(TTierValue);
}
const TTiers = Type.Object(tierPropSchemas, { additionalProperties: false });

const TBackend = Type.Object(
	{
		resetSchedule: Type.Optional(TResetSchedule),
		tiers: TTiers,
		quotaHint: Type.Optional(TQuotaHint),
		capStatusCodes: Type.Optional(Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), { minItems: 1 })),
	},
	{ additionalProperties: false },
);

/** Raw (as-in-file) config schema — normalized version has defaults applied. */
export const AliasesConfigRawSchema = Type.Object(
	{
		fallbackChain: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		backends: Type.Record(Type.String({ minLength: 1 }), TBackend),
	},
	{ additionalProperties: false },
);

export type AliasesConfigRaw = Static<typeof AliasesConfigRawSchema>;
export type BackendConfigRaw = Static<typeof TBackend>;

/**
 * Normalized runtime config. Optional fields resolved to defaults. Each tier
 * value is normalized to a non-empty ordered list of model IDs; a single
 * string in the source file becomes a 1-element array.
 */
export interface BackendConfig {
	resetSchedule: ResetSchedule | undefined;
	tiers: Readonly<Partial<Record<TierSlot, readonly string[]>>>;
	quotaHint: QuotaHint | undefined;
	capStatusCodes: readonly number[];
}

export interface AliasesConfig {
	fallbackChain: readonly string[];
	backends: Readonly<Record<string, BackendConfig>>;
}

// ---------- Loader errors ----------

export class AliasesConfigError extends Error {
	constructor(
		message: string,
		public readonly cause?: "missing" | "parse" | "schema" | "semantic",
		public readonly path?: string,
	) {
		super(message);
		this.name = "AliasesConfigError";
	}
}

// ---------- Loader ----------

/**
 * Read + validate + normalize an aliases.json file.
 * @param filePath Path to aliases.json (typically ~/.pi/agent/aliases.json).
 * @returns The normalized AliasesConfig.
 * @throws AliasesConfigError on missing file, invalid JSON, or schema violation.
 */
export function loadAliasesConfig(filePath: string): AliasesConfig {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new AliasesConfigError(`aliases.json not found at ${filePath}`, "missing", filePath);
		}
		throw new AliasesConfigError(`failed to read ${filePath}: ${(err as Error).message}`, "parse", filePath);
	}
	return parseAliasesConfig(raw, filePath);
}

/**
 * Read + validate an aliases.json file into its RAW (un-normalized) shape,
 * preserving exactly what is in the file: single-string tiers stay strings,
 * omitted optionals stay absent. This is the editable draft model for the TUI
 * editor — editing raw avoids churning the file with normalization artifacts
 * (e.g. rewriting a single string tier as a one-element array, or materializing
 * default capStatusCodes). Schema-validated but NOT semantically checked, so a
 * work-in-progress draft can be loaded; use {@link parseAliasesConfig} (via the
 * writer's validate step) to enforce semantics before persisting.
 *
 * @throws AliasesConfigError on missing file, invalid JSON, or schema violation.
 */
export function loadAliasesConfigRaw(filePath: string): AliasesConfigRaw {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new AliasesConfigError(`aliases.json not found at ${filePath}`, "missing", filePath);
		}
		throw new AliasesConfigError(`failed to read ${filePath}: ${(err as Error).message}`, "parse", filePath);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new AliasesConfigError(`invalid JSON in ${filePath}: ${(err as Error).message}`, "parse", filePath);
	}
	if (!Value.Check(AliasesConfigRawSchema, parsed)) {
		const firstError = [...Value.Errors(AliasesConfigRawSchema, parsed)][0];
		throw new AliasesConfigError(
			`schema error at ${filePath}${firstError?.path ?? ""}: ${firstError?.message ?? "unknown validation error"}`,
			"schema",
			`${filePath}${firstError?.path ?? ""}`,
		);
	}
	return parsed as AliasesConfigRaw;
}

/**
 * Parse + validate + normalize an aliases.json body (already read).
 * Exported separately for tests that don't want to touch the filesystem.
 */
export function parseAliasesConfig(source: string, filePath = "<aliases.json>"): AliasesConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (err) {
		throw new AliasesConfigError(
			`invalid JSON in ${filePath}: ${(err as Error).message}`,
			"parse",
			filePath,
		);
	}

	// Schema-level validation.
	if (!Value.Check(AliasesConfigRawSchema, parsed)) {
		const firstError = [...Value.Errors(AliasesConfigRawSchema, parsed)][0];
		const errPath = firstError?.path ?? "";
		const errMsg = firstError?.message ?? "unknown validation error";
		throw new AliasesConfigError(
			`schema error at ${filePath}${errPath}: ${errMsg}`,
			"schema",
			`${filePath}${errPath}`,
		);
	}

	const rawConfig = parsed as AliasesConfigRaw;

	// Semantic checks: every backend named in fallbackChain must exist.
	for (const name of rawConfig.fallbackChain) {
		if (!Object.prototype.hasOwnProperty.call(rawConfig.backends, name)) {
			throw new AliasesConfigError(
				`fallbackChain references unknown backend '${name}' (not in backends)`,
				"semantic",
				`${filePath}/fallbackChain`,
			);
		}
	}

	// Every backend must declare at least one tier, and no tier may be an empty
	// list. (TypeBox minItems catches empty arrays at schema level, but keep an
	// explicit semantic check so the error cause is stable for callers.)
	for (const [name, backend] of Object.entries(rawConfig.backends)) {
		if (Object.keys(backend.tiers).length === 0) {
			throw new AliasesConfigError(
				`backend '${name}' declares no tiers`,
				"semantic",
				`${filePath}/backends/${name}/tiers`,
			);
		}
		for (const [slot, value] of Object.entries(backend.tiers)) {
			if (Array.isArray(value) && value.length === 0) {
				throw new AliasesConfigError(
					`backend '${name}' tier '${slot}' is an empty list`,
					"semantic",
					`${filePath}/backends/${name}/tiers/${slot}`,
				);
			}
		}
	}

	return normalize(rawConfig);
}

function normalize(raw: AliasesConfigRaw): AliasesConfig {
	const backends: Record<string, BackendConfig> = {};
	for (const [name, b] of Object.entries(raw.backends)) {
		const tiers: Partial<Record<TierSlot, readonly string[]>> = {};
		for (const [slot, value] of Object.entries(b.tiers)) {
			tiers[slot as TierSlot] = Array.isArray(value) ? [...value] : [value];
		}
		backends[name] = {
			resetSchedule: b.resetSchedule,
			tiers,
			quotaHint: b.quotaHint,
			capStatusCodes: b.capStatusCodes ?? DEFAULT_CAP_STATUS_CODES,
		};
	}
	return {
		fallbackChain: [...raw.fallbackChain],
		backends,
	};
}
