/**
 * Failover detection: turn a failed provider response into a backend health
 * transition. Capacity errors use the backend's reset schedule; transient HTTP
 * and network failures use a short cooldown.
 *
 * Pure functions only — no state I/O. The caller decides how to persist
 * and re-register.
 */

import type { AliasesConfig, BackendConfig } from "./config.js";
import { enrichQuota } from "./enrichers.js";
import { nextResetInstant } from "./reset-schedule.js";
import type { GatewayState, UnhealthyEntry } from "./state.js";

/** The minimal shape we need from a pi assistant message-end event. */
export interface CapEventInput {
	/** Structured HTTP status exposed by modern Pi and OMP providers. */
	errorStatus?: number;
	/** Assistant error text. Older providers may prefix this with the status. */
	errorMessage: string | undefined;
	/** stopReason from the assistant message. */
	stopReason: string | undefined;
	/** ctx.model.provider — which backend the request was routed to. */
	provider: string | undefined;
	/** ctx.model.id — which real model was hit. */
	modelId: string | undefined;
}

export interface CapEventOutcome {
	/** Was this event recognized as a failover-worthy backend failure? */
	capHit: boolean;
	kind?: "capacity" | "transient";
	/** Which backend, if any. Undefined when we didn't recognize the event. */
	backendName?: string;
	/** Parsed HTTP status (e.g. 402). */
	status?: number;
	/** Raw response body (portion of errorMessage after "<status>: "). */
	body?: string;
	/** Proposed unhealthyUntil entry. Caller decides whether to persist. */
	entry?: UnhealthyEntry;
}

/**
 * Parse a message_end error into a cap-event outcome. Returns
 * `{ capHit: false }` when the event isn't a cap hit or can't be attributed
 * to a known backend.
 */
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_ERROR = /fetch failed|network error|ECONN(?:RESET|REFUSED)|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset|service unavailable/i;

export function classifyCapEvent(
	event: CapEventInput,
	aliases: AliasesConfig,
	now: Date = new Date(),
	routing?: Record<string, string>,
): CapEventOutcome {
	if (event.stopReason !== "error") return { capHit: false };
	if (!event.provider) return { capHit: false };

	// Only fires for the gateway provider itself — if the message went out via
	// a different provider (e.g. user selected anthropic directly), we don't
	// track it.
	const backendName = resolveGatewayModelToBackend(event.provider, event.modelId, aliases, routing);
	if (!backendName) return { capHit: false };

	const prefixed = event.errorMessage ? parseStatusPrefix(event.errorMessage) : undefined;
	const status = validStatus(event.errorStatus) ?? prefixed?.status ?? parseHttpStatus(event.errorMessage);
	const body = prefixed?.body ?? event.errorMessage ?? "";
	const backend = aliases.backends[backendName];
	const capacity = status !== undefined && backend.capStatusCodes.includes(status);
	const transient =
		(status !== undefined && TRANSIENT_STATUS_CODES.has(status)) ||
		(status === undefined && TRANSIENT_ERROR.test(body));
	if (!capacity && !transient) return { capHit: false };

	const untilInstant = capacity
		? nextResetInstant(backend.resetSchedule, now)
		: new Date(now.getTime() + TRANSIENT_COOLDOWN_MS);
	const quota = capacity ? enrichQuota(backend.quotaHint, body) : undefined;
	const kind = capacity ? "capacity" : "transient";
	const statusLabel = status === undefined ? "network error" : `HTTP ${status}`;
	const entry: UnhealthyEntry = {
		until: untilInstant.toISOString(),
		reason: `${statusLabel} on ${event.modelId ?? "?"} — ${kind} failure`,
		...(quota ? { quota } : {}),
	};

	return {
		capHit: true,
		kind,
		backendName,
		status,
		body,
		entry,
	};
}

/**
 * Return an updated GatewayState with the given backend marked unhealthy.
 * Idempotent when the new entry is not strictly later than the existing one
 * (extending TTL only, never shortening).
 */
export function applyCapOutcome(
	state: GatewayState,
	backendName: string,
	entry: UnhealthyEntry,
): GatewayState {
	const existing = state.unhealthyUntil[backendName];
	if (existing) {
		const existingMs = Date.parse(existing.until);
		const newMs = Date.parse(entry.until);
		if (Number.isFinite(existingMs) && Number.isFinite(newMs) && newMs <= existingMs) {
			return state;
		}
	}
	return {
		...state,
		unhealthyUntil: {
			...state.unhealthyUntil,
			[backendName]: entry,
		},
	};
}

/**
 * Given a gateway alias id, figure out which backend the alias routed to.
 *
 * Indexed neutral aliases (e.g. `heavy-2`) are backend-agnostic by design, and
 * their routing depends on live health at compose time. The authoritative
 * source is therefore the `routing` map produced by composeGatewayModels
 * (alias id → backend name). When that map is provided and contains the alias,
 * it wins.
 *
 * Fallback (map absent, e.g. a stale event that predates the latest compose):
 * best-effort attribution to the first backend in the fallback chain that
 * declares the alias's tier slot. This can be imprecise under failover, so the
 * routing map is strongly preferred.
 */
function resolveGatewayModelToBackend(
	provider: string,
	modelId: string | undefined,
	aliases: AliasesConfig,
	routing?: Record<string, string>,
): string | undefined {
	if (provider !== "gateway") return undefined;
	if (!modelId) return undefined;

	// Authoritative: the compose-time routing map.
	if (routing && modelId in routing) return routing[modelId];

	// Best-effort fallback: parse the tier slot from the indexed alias and
	// attribute to the first chain backend that declares it.
	const indexedMatch = modelId.match(/^(heavy|medium|light|xlight|minimal)-(\d+)$/);
	if (indexedMatch) {
		const slot = indexedMatch[1];
		for (const name of aliases.fallbackChain) {
			const backend = aliases.backends[name];
			if (backend && slot in backend.tiers) return name;
		}
	}

	return undefined;
}

/** Parse "<status>: <body>" leading prefix from an errorMessage. */
export function parseStatusPrefix(
	errorMessage: string,
): { status: number; body: string } | undefined {
	const m = errorMessage.match(/^(\d+):\s*([\s\S]*)$/);
	if (!m) return undefined;
	const status = validStatus(Number.parseInt(m[1], 10));
	return status === undefined ? undefined : { status, body: m[2] };
}

function parseHttpStatus(errorMessage: string | undefined): number | undefined {
	if (!errorMessage) return undefined;
	const prefixed = parseStatusPrefix(errorMessage);
	if (prefixed) return prefixed.status;
	const match = errorMessage.match(/^(\d{3})(?:\s|$)|\b(?:HTTP|failed)\s+(\d{3})\b/i);
	return validStatus(Number.parseInt(match?.[1] ?? match?.[2] ?? "", 10));
}

function validStatus(status: number | undefined): number | undefined {
	return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
}
