/**
 * aliases.json editor model + atomic writer.
 *
 * The TUI editor mutates a RAW config draft ({@link AliasesConfigRaw}) via the
 * pure helpers here, then persists it with {@link writeAliasesConfig}. Editing
 * the raw shape (not the normalized {@link AliasesConfig}) keeps the on-disk
 * file faithful: single-string tiers, omitted optionals, and user key order are
 * all preserved, so saving only reflects the edits the user actually made.
 *
 * Every edit helper is a pure function: it returns a new draft and never
 * mutates its input. Validation is deferred to save time (a work-in-progress
 * draft may be transiently invalid, e.g. a backend with no tiers yet); the
 * writer validates and refuses to persist an invalid config.
 */

import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

import {
	AliasesConfigError,
	type AliasesConfigRaw,
	type BackendConfigRaw,
	parseAliasesConfig,
	type QuotaHint,
	type ResetSchedule,
	type TierSlot,
} from "./config.js";

// ---------- Draft helpers (pure) ----------

/** A fresh, empty draft. Not valid to save until it has a backend + chain. */
export function emptyDraft(): AliasesConfigRaw {
	return { fallbackChain: [], backends: {} };
}

/** Deep clone a draft so edits never alias the caller's object. */
export function cloneDraft(raw: AliasesConfigRaw): AliasesConfigRaw {
	return structuredClone(raw);
}

function withBackends(
	raw: AliasesConfigRaw,
	backends: Record<string, BackendConfigRaw>,
): AliasesConfigRaw {
	return { ...raw, backends };
}

/** Add an empty backend (no tiers yet). No-op if the name already exists. */
export function addBackend(raw: AliasesConfigRaw, name: string): AliasesConfigRaw {
	if (name in raw.backends) return raw;
	return withBackends(raw, { ...raw.backends, [name]: { tiers: {} } });
}

/** Remove a backend and drop it from the fallback chain. */
export function removeBackend(raw: AliasesConfigRaw, name: string): AliasesConfigRaw {
	if (!(name in raw.backends)) return raw;
	const backends: Record<string, BackendConfigRaw> = {};
	for (const [k, v] of Object.entries(raw.backends)) if (k !== name) backends[k] = v;
	return {
		...raw,
		backends,
		fallbackChain: raw.fallbackChain.filter((n) => n !== name),
	};
}

/**
 * Rename a backend, preserving key order and updating fallbackChain references.
 * No-op if `from` is missing or `to` already exists (or equals `from`).
 */
export function renameBackend(raw: AliasesConfigRaw, from: string, to: string): AliasesConfigRaw {
	if (from === to) return raw;
	if (!(from in raw.backends) || to in raw.backends) return raw;
	const backends: Record<string, BackendConfigRaw> = {};
	for (const [k, v] of Object.entries(raw.backends)) backends[k === from ? to : k] = v;
	return {
		...raw,
		backends,
		fallbackChain: raw.fallbackChain.map((n) => (n === from ? to : n)),
	};
}

function editBackend(
	raw: AliasesConfigRaw,
	name: string,
	fn: (b: BackendConfigRaw) => BackendConfigRaw,
): AliasesConfigRaw {
	const cur = raw.backends[name];
	if (!cur) return raw;
	return withBackends(raw, { ...raw.backends, [name]: fn(cur) });
}

/** Set (or clear, with undefined) a backend's reset schedule. */
export function setResetSchedule(
	raw: AliasesConfigRaw,
	name: string,
	schedule: ResetSchedule | undefined,
): AliasesConfigRaw {
	return editBackend(raw, name, (b) => {
		const next = { ...b };
		if (schedule === undefined) delete next.resetSchedule;
		else next.resetSchedule = schedule;
		return next;
	});
}

/** Set (or clear, with undefined) a backend's quota hint. */
export function setQuotaHint(
	raw: AliasesConfigRaw,
	name: string,
	hint: QuotaHint | undefined,
): AliasesConfigRaw {
	return editBackend(raw, name, (b) => {
		const next = { ...b };
		if (hint === undefined) delete next.quotaHint;
		else next.quotaHint = hint;
		return next;
	});
}

/**
 * Set (or clear, with undefined) a backend's cap status codes. Clearing falls
 * back to the default (402, 429) at normalize time.
 */
export function setCapStatusCodes(
	raw: AliasesConfigRaw,
	name: string,
	codes: number[] | undefined,
): AliasesConfigRaw {
	return editBackend(raw, name, (b) => {
		const next = { ...b };
		if (codes === undefined || codes.length === 0) delete next.capStatusCodes;
		else next.capStatusCodes = [...codes];
		return next;
	});
}

/**
 * Set the ordered model list for a tier. An empty list removes the tier slot
 * entirely (a tier must be non-empty to be valid).
 */
export function setTierModels(
	raw: AliasesConfigRaw,
	name: string,
	slot: TierSlot,
	models: string[],
): AliasesConfigRaw {
	return editBackend(raw, name, (b) => {
		const tiers = { ...b.tiers };
		if (models.length === 0) delete tiers[slot];
		else tiers[slot] = [...models];
		return { ...b, tiers };
	});
}

/** Replace the entire fallback chain. */
export function setFallbackChain(raw: AliasesConfigRaw, chain: string[]): AliasesConfigRaw {
	return { ...raw, fallbackChain: [...chain] };
}

/**
 * Return a tier's models as an array regardless of the raw single-string vs
 * list form. Empty array when the tier is not declared.
 */
export function tierModels(b: BackendConfigRaw | undefined, slot: TierSlot): string[] {
	const v = b?.tiers?.[slot] as string | string[] | undefined;
	if (v === undefined) return [];
	return Array.isArray(v) ? [...v] : [v];
}

// ---------- Validation ----------

export interface DraftValidation {
	ok: boolean;
	/** Specific, user-facing message when ok is false. */
	message?: string;
}

/**
 * Validate a draft the same way the loader would: schema + semantic checks.
 * Reuses {@link parseAliasesConfig} against the serialized draft so the rules
 * never drift. Returns a result rather than throwing so the editor can surface
 * the message inline.
 */
export function validateDraft(raw: AliasesConfigRaw): DraftValidation {
	try {
		parseAliasesConfig(JSON.stringify(raw));
		return { ok: true };
	} catch (err) {
		if (err instanceof AliasesConfigError) return { ok: false, message: err.message };
		return { ok: false, message: (err as Error).message };
	}
}

// ---------- Atomic writer ----------

let tmpCounter = 0;

const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MIN_MS = 5;
const LOCK_POLL_MAX_MS = 25;

function lockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function acquireLock(filePath: string): void {
	const path = lockPath(filePath);
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, `${process.pid}\n`);
			closeSync(fd);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new AliasesConfigError(
					`failed to acquire lock at ${path}: ${(err as Error).message}`,
					"parse",
				);
			}
			if (Date.now() >= deadline) {
				throw new AliasesConfigError(
					`timed out acquiring lock at ${path} (held by another writer)`,
					"parse",
				);
			}
			const wait = LOCK_POLL_MIN_MS + Math.floor(Math.random() * (LOCK_POLL_MAX_MS - LOCK_POLL_MIN_MS));
			const end = Date.now() + wait;
			while (Date.now() < end) {
				// spin — millisecond-scale wait for a rarely-written file
			}
		}
	}
}

function releaseLock(filePath: string): void {
	try {
		unlinkSync(lockPath(filePath));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new AliasesConfigError(
				`failed to release lock at ${lockPath(filePath)}: ${(err as Error).message}`,
				"parse",
			);
		}
	}
}

/**
 * Validate then write aliases.json atomically (tmp file + rename, guarded by a
 * same-machine lockfile). Refuses to persist an invalid draft.
 *
 * @throws AliasesConfigError when the draft is invalid or the write fails.
 */
export function writeAliasesConfig(filePath: string, raw: AliasesConfigRaw): void {
	const validation = validateDraft(raw);
	if (!validation.ok) {
		throw new AliasesConfigError(
			`refusing to write invalid aliases.json: ${validation.message}`,
			"semantic",
			filePath,
		);
	}
	acquireLock(filePath);
	try {
		const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpCounter}.${Date.now()}`;
		const body = `${JSON.stringify(raw, null, "\t")}\n`;
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
