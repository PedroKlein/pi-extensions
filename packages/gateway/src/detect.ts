/**
 * Cap detection: turn a `message_end` event with `stopReason: "error"` into
 * a health-state transition.
 *
 * Per P0-T4 finding: pi does NOT fire `after_provider_response` on non-2xx
 * responses. On a 402/429 the failure surfaces via `message_end` as an
 * assistant message whose `errorMessage` is formatted `"<status>: <body>"`.
 * This module parses that shape.
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
	/** Assistant errorMessage in "<status>: <body>" shape. */
	errorMessage: string | undefined;
	/** stopReason from the assistant message. */
	stopReason: string | undefined;
	/** ctx.model.provider — which backend the request was routed to. */
	provider: string | undefined;
	/** ctx.model.id — which real model was hit. */
	modelId: string | undefined;
}

export interface CapEventOutcome {
	/** Was this event recognized as a cap hit? */
	capHit: boolean;
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
export function classifyCapEvent(
	event: CapEventInput,
	aliases: AliasesConfig,
	now: Date = new Date(),
): CapEventOutcome {
	if (event.stopReason !== "error") return { capHit: false };
	if (!event.errorMessage) return { capHit: false };
	if (!event.provider) return { capHit: false };

	// Only fires for the gateway provider itself — if the message went out via
	// a different provider (e.g. user selected anthropic directly), we don't
	// track it.
	const backendName = resolveGatewayModelToBackend(event.provider, event.modelId, aliases);
	if (!backendName) return { capHit: false };

	const parsed = parseStatusPrefix(event.errorMessage);
	if (!parsed) return { capHit: false };

	const backend = aliases.backends[backendName];
	const codes = backend.capStatusCodes;
	if (!codes.includes(parsed.status)) return { capHit: false };

	const untilInstant = nextResetInstant(backend.resetSchedule, now);
	const quota = enrichQuota(backend.quotaHint, parsed.body);
	const entry: UnhealthyEntry = {
		until: untilInstant.toISOString(),
		reason: `HTTP ${parsed.status} on ${event.modelId ?? "?"} — cap hit`,
		...(quota ? { quota } : {}),
	};

	return {
		capHit: true,
		backendName,
		status: parsed.status,
		body: parsed.body,
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
 * Given a gateway alias id and the aliases config, figure out which backend
 * the alias currently routes to.
 *
 * For family-pinned aliases (e.g. `heavy-hai-1`), the backend is unambiguous.
 * For family-neutral aliases (e.g. `heavy-1`), we can't determine the backend
 * from static aliases alone — but the caller passes `ctx.model` which has
 * already resolved to a specific baseUrl. In practice this attribution runs
 * during error handling; the caller must decide whether to attribute
 * ambiguous cases (see docs). For now we return the family-pinned backend
 * or the first backend in fallbackChain that declares this tier.
 */
function resolveGatewayModelToBackend(
	provider: string,
	modelId: string | undefined,
	aliases: AliasesConfig,
): string | undefined {
	if (provider !== "gateway") return undefined;
	if (!modelId) return undefined;

	// Family-pinned: "<slot>-<family-suffix>-1"
	const familyMatch = modelId.match(/^(heavy|medium|light|xlight|minimal)-([a-z0-9]+)-1$/);
	if (familyMatch) {
		const suffix = familyMatch[2];
		for (const name of Object.keys(aliases.backends)) {
			if (backendMatchesSuffix(name, suffix)) return name;
		}
		return undefined;
	}

	// Family-neutral: "<slot>-1". Attribute to the first backend in chain that
	// declares this tier — this is a best-effort attribution. In practice P4-T2
	// takes the current composed model list (which encodes actual routing) into
	// account; the message_end handler can pass a `resolvedBackend` override.
	const neutralMatch = modelId.match(/^(heavy|medium|light|xlight|minimal)-1$/);
	if (neutralMatch) {
		const slot = neutralMatch[1];
		for (const name of aliases.fallbackChain) {
			const backend = aliases.backends[name];
			if (backend && slot in backend.tiers) return name;
		}
	}

	return undefined;
}

function backendMatchesSuffix(backendName: string, suffix: string): boolean {
	const parts = backendName.split(/[-_]/).filter(Boolean);
	return parts.includes(suffix);
}

/** Parse "<status>: <body>" leading prefix from an errorMessage. */
export function parseStatusPrefix(
	errorMessage: string,
): { status: number; body: string } | undefined {
	const m = errorMessage.match(/^(\d+):\s*([\s\S]*)$/);
	if (!m) return undefined;
	const status = Number.parseInt(m[1], 10);
	if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
	return { status, body: m[2] };
}
