/**
 * quotaHint enrichers.
 *
 * A quotaHint is a name-tagged parser that turns a raw cap-response body
 * into a structured { spent, cap, currency } tuple, purely for TUI display.
 * Cap detection itself does NOT depend on enricher output.
 *
 * v1 ships a single enricher — `daily-eur-cap` — matching a
 * `DAILY_CAP_EXCEEDED` error body with `cap_eur` / `spent_eur` fields. Add
 * more entries here as backends reveal their error formats. Enrichers must
 * never throw; return `undefined` on anything unrecognized.
 */

import type { QuotaHint } from "./config.js";
import type { QuotaInfo } from "./state.js";

export type QuotaEnricher = (body: string) => QuotaInfo | undefined;

export const ENRICHERS: Record<QuotaHint, QuotaEnricher> = {
	"daily-eur-cap": dailyEurCapEnricher,
};

/**
 * Run the named enricher on a raw response body. Returns undefined for
 * unknown hint names, invalid JSON, or malformed content. Never throws.
 */
export function enrichQuota(hint: QuotaHint | undefined, body: string): QuotaInfo | undefined {
	if (!hint) return undefined;
	const enricher = ENRICHERS[hint];
	if (!enricher) return undefined;
	try {
		return enricher(body);
	} catch {
		return undefined;
	}
}

function dailyEurCapEnricher(body: string): QuotaInfo | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const error = (parsed as { error?: unknown }).error;
	if (!error || typeof error !== "object") return undefined;
	const e = error as { code?: unknown; cap_eur?: unknown; spent_eur?: unknown };
	if (e.code !== "DAILY_CAP_EXCEEDED") return undefined;
	const cap = toFloat(e.cap_eur);
	const spent = toFloat(e.spent_eur);
	if (cap === undefined || spent === undefined) return undefined;
	return { spent, cap, currency: "EUR" };
}

function toFloat(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number.parseFloat(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}
