/**
 * gateway-state.json — persistent per-machine state.
 *
 * File shape (version: 1):
 *   {
 *     "version": 1,
 *     "unhealthyUntil": {
 *       "<backendName>": {
 *         "until": "2025-01-15T00:00:00.000Z",
 *         "reason": "402 cap hit",
 *         "quota": { "spent": 50.27, "cap": 50.00, "currency": "EUR" }
 *       }
 *     },
 *     "activeBackendOverride": "hai-proxy",
 *     "fallbackChainOverride": ["hai-proxy", "github-copilot"]
 *   }
 *
 * Persistence rules:
 * - Atomic write: write to `<file>.tmp.<pid>.<counter>`, then fs.rename over dest.
 * - Same-machine lockfile at `<file>.lock` (O_EXCL open) to serialize writers.
 * - Missing file → treated as fresh empty state.
 */

import {
	closeSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
	readFileSync,
} from "node:fs";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const STATE_FILE_VERSION = 1 as const;

// ---------- Schema ----------

const TQuotaInfo = Type.Object(
	{
		spent: Type.Number(),
		cap: Type.Number(),
		currency: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const TUnhealthyEntry = Type.Object(
	{
		// ISO 8601 timestamp. We validate parseability with a Type.Transform-free
		// pattern rather than TypeBox's optional 'date-time' format registry.
		until: Type.String({ minLength: 1, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$" }),
		reason: Type.String(),
		quota: Type.Optional(TQuotaInfo),
	},
	{ additionalProperties: false },
);

export const GatewayStateSchema = Type.Object(
	{
		version: Type.Literal(STATE_FILE_VERSION),
		unhealthyUntil: Type.Record(Type.String({ minLength: 1 }), TUnhealthyEntry),
		activeBackendOverride: Type.Optional(Type.String({ minLength: 1 })),
		fallbackChainOverride: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	},
	{ additionalProperties: false },
);

export type QuotaInfo = Static<typeof TQuotaInfo>;
export type UnhealthyEntry = Static<typeof TUnhealthyEntry>;
export type GatewayState = Static<typeof GatewayStateSchema>;

/** Empty state used when the file does not exist. */
export function emptyState(): GatewayState {
	return {
		version: STATE_FILE_VERSION,
		unhealthyUntil: {},
		activeBackendOverride: undefined,
		fallbackChainOverride: undefined,
	};
}

// ---------- Errors ----------

export class GatewayStateError extends Error {
	constructor(
		message: string,
		public readonly cause?: "parse" | "schema" | "io" | "lock",
	) {
		super(message);
		this.name = "GatewayStateError";
	}
}

// ---------- Read / write ----------

/**
 * Read gateway-state.json. If the file does not exist, returns emptyState().
 * Throws on parse or schema errors.
 */
export function readState(filePath: string): GatewayState {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyState();
		}
		throw new GatewayStateError(
			`failed to read ${filePath}: ${(err as Error).message}`,
			"io",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new GatewayStateError(
			`invalid JSON in ${filePath}: ${(err as Error).message}`,
			"parse",
		);
	}
	if (!Value.Check(GatewayStateSchema, parsed)) {
		const first = [...Value.Errors(GatewayStateSchema, parsed)][0];
		throw new GatewayStateError(
			`schema error at ${filePath}${first?.path ?? ""}: ${first?.message ?? "unknown"}`,
			"schema",
		);
	}
	return parsed as GatewayState;
}

let tmpCounter = 0;

/**
 * Write gateway-state.json atomically.
 *
 * Strategy:
 * 1. Acquire an exclusive lockfile at `<filePath>.lock` via O_EXCL.
 *    Retries with jittered backoff up to ~2s; other writers wait or abort.
 * 2. Serialize the state (must pass schema validation; version is stamped).
 * 3. Write to `<filePath>.tmp.<pid>.<counter>` (fully flushed).
 * 4. `fs.rename` the temp file over the destination (atomic on POSIX).
 * 5. Release the lockfile.
 *
 * Concurrent writers are serialized; the last writer wins. The destination
 * file is never in a torn state.
 */
export function writeState(filePath: string, state: GatewayState): void {
	// Enforce version at write time.
	const stamped: GatewayState = { ...state, version: STATE_FILE_VERSION };
	if (!Value.Check(GatewayStateSchema, stamped)) {
		const first = [...Value.Errors(GatewayStateSchema, stamped)][0];
		throw new GatewayStateError(
			`refusing to write invalid state: ${first?.path ?? ""} ${first?.message ?? "unknown"}`,
			"schema",
		);
	}

	acquireLock(filePath);
	try {
		const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpCounter}.${Date.now()}`;
		const body = `${JSON.stringify(stamped, null, "\t")}\n`;
		// Write + sync in one call.
		const fd = openSync(tmpPath, "w", 0o600);
		try {
			writeSync(fd, body);
		} finally {
			closeSync(fd);
		}
		renameSync(tmpPath, filePath);
	} finally {
		releaseLock(filePath);
	}
}

/**
 * Read + mutate + write in one atomic-ish flow. The mutator receives a snapshot
 * of current state and must return the new state (or the same instance).
 * Uses the same lockfile as writeState, so concurrent updates are serialized.
 */
export function updateState(
	filePath: string,
	mutate: (current: GatewayState) => GatewayState,
): GatewayState {
	acquireLock(filePath);
	try {
		const current = readStateWithoutLock(filePath);
		const next = mutate(current);
		writeStateWithoutLock(filePath, next);
		return next;
	} finally {
		releaseLock(filePath);
	}
}

function readStateWithoutLock(filePath: string): GatewayState {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Value.Check(GatewayStateSchema, parsed)) {
			const first = [...Value.Errors(GatewayStateSchema, parsed)][0];
			throw new GatewayStateError(
				`schema error at ${filePath}${first?.path ?? ""}: ${first?.message ?? "unknown"}`,
				"schema",
			);
		}
		return parsed as GatewayState;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyState();
		}
		throw err;
	}
}

function writeStateWithoutLock(filePath: string, state: GatewayState): void {
	const stamped: GatewayState = { ...state, version: STATE_FILE_VERSION };
	if (!Value.Check(GatewayStateSchema, stamped)) {
		const first = [...Value.Errors(GatewayStateSchema, stamped)][0];
		throw new GatewayStateError(
			`refusing to write invalid state: ${first?.path ?? ""} ${first?.message ?? "unknown"}`,
			"schema",
		);
	}
	const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpCounter}.${Date.now()}`;
	const body = `${JSON.stringify(stamped, null, "\t")}\n`;
	writeFileSync(tmpPath, body, { mode: 0o600 });
	renameSync(tmpPath, filePath);
}

// ---------- Lockfile ----------

const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MIN_MS = 5;
const LOCK_POLL_MAX_MS = 25;

function lockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function acquireLock(filePath: string): void {
	const path = lockPath(filePath);
	const deadline = Date.now() + LOCK_WAIT_MS;
	// Busy-wait with small jitter — this file is written rarely and holders
	// release quickly, so a tight spin is fine for a same-machine lock.
	while (true) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, `${process.pid}\n`);
			closeSync(fd);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new GatewayStateError(
					`failed to acquire lock at ${path}: ${(err as Error).message}`,
					"lock",
				);
			}
			if (Date.now() >= deadline) {
				throw new GatewayStateError(
					`timed out acquiring lock at ${path} (held by another writer)`,
					"lock",
				);
			}
			// Sleep synchronously to keep write() call-site simple.
			const wait =
				LOCK_POLL_MIN_MS + Math.floor(Math.random() * (LOCK_POLL_MAX_MS - LOCK_POLL_MIN_MS));
			const end = Date.now() + wait;
			// Atomics.wait would be cleaner but requires a SharedArrayBuffer; this
			// tight loop is fine for millisecond-scale waits.
			while (Date.now() < end) {
				// no-op spin
			}
		}
	}
}

function releaseLock(filePath: string): void {
	const path = lockPath(filePath);
	try {
		unlinkSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new GatewayStateError(
				`failed to release lock at ${path}: ${(err as Error).message}`,
				"lock",
			);
		}
	}
}
