/**
 * pi-subagents-bridge — the ONLY module in pi-task that references pi-subagents.
 *
 * All coupling is dynamic (via `import()`) and version-tolerant (feature-detects).
 * See `docs/design/pi-subagents-coupling.md` for rationale and the coupling contract.
 *
 * Contract:
 *   - Never throws on the happy path or the missing-package path.
 *   - Returns `{ remaining: "unknown" }` when the bridge cannot resolve pi-subagents.
 *   - Logs at most once per pi-task session on failure (rate-limited).
 *   - Compile-time import of pi-subagents is FORBIDDEN — enforced by the P3.7 oracle
 *     and grep-based descriptor tests.
 */

/**
 * Live spawn budget as visible to a running session. All fields except
 * `remaining: "unknown"` are numeric.
 */
export interface SpawnBudget {
	/** Number of subagents already spawned in this session, or `"unknown"`. */
	spawned: number | "unknown";
	/** Configured cap for the session (defaults to `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`), or `"unknown"`. */
	cap: number | "unknown";
	/** Slots still available: max(0, cap - spawned), or `"unknown"`. */
	remaining: number | "unknown";
	/** Currently active (foreground + async) run count, or `"unknown"`. */
	activeRuns: number | "unknown";
	/** Optional reason string when a field is `"unknown"`. */
	reason?: string;
}

const UNKNOWN_BUDGET: SpawnBudget = {
	spawned: "unknown",
	cap: "unknown",
	remaining: "unknown",
	activeRuns: "unknown",
	reason: "bridge-not-initialised",
};

// ─── Rate-limited failure logging ────────────────────────────────────────

let loggedProbeFailure = false;

function logProbeFailureOnce(reason: string): void {
	if (loggedProbeFailure) return;
	loggedProbeFailure = true;
	console.warn(
		`[pi-task] pi-subagents budget probe unavailable: ${reason}. ` +
			`Budget lines will show "probe-unavailable"; executor enforcement degrades to warn-only. ` +
			`This is logged once per session.`,
	);
}

/** Test hook: reset the once-per-session log gate. Do not call from production code. */
export function _resetProbeLogGateForTests(): void {
	loggedProbeFailure = false;
}

// ─── Feature detection ───────────────────────────────────────────────────

/**
 * Shape we look for on the dynamically-imported pi-subagents package.
 * Anything less returns UNKNOWN_BUDGET; we never crash on a version mismatch.
 */
interface PiSubagentsProbe {
	/** Optional in older pi-subagents; the bridge tolerates absence. */
	getSpawnBudget?: () => SpawnBudget | Promise<SpawnBudget>;
	/** Fallback: some exports report just the numbers. */
	getBudget?: () => { spawned: number; cap: number; activeRuns: number };
}

/**
 * Injection point for tests. When set, `getSpawnBudget()` uses this instead
 * of a dynamic import. Reset by calling with `null`.
 */
let injectedProbe: PiSubagentsProbe | null | "disabled" = null;

/** Test hook: pretend pi-subagents is unavailable. */
export function _setBridgeMock(probe: PiSubagentsProbe | null | "disabled"): void {
	injectedProbe = probe;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Read the live subagent budget for the current session.
 *
 * Never throws. On any failure path, returns `UNKNOWN_BUDGET` with a `reason`
 * hinting why (missing package, missing export, exception thrown from probe).
 */
export async function getSpawnBudget(): Promise<SpawnBudget> {
	if (injectedProbe === "disabled") {
		logProbeFailureOnce("mock-disabled");
		return { ...UNKNOWN_BUDGET, reason: "mock-disabled" };
	}

	let probe: PiSubagentsProbe | null = null;
	if (injectedProbe && injectedProbe !== ("disabled" as typeof injectedProbe)) {
		probe = injectedProbe as PiSubagentsProbe;
	} else if (injectedProbe === null) {
		try {
			// Dynamic import so pi-task doesn't compile-time-link against pi-subagents.
			// The specifier is built at call time so tsc doesn't try to resolve
			// the module at build time. Any resolver failure means pi-subagents
			// isn't installed — degrade silently.
			const specifier = ["pi", "subagents"].join("-");
			probe = (await import(/* @vite-ignore */ specifier)) as unknown as PiSubagentsProbe;
		} catch (err) {
			const reason = err instanceof Error ? err.message : "import-failed";
			logProbeFailureOnce(reason);
			return { ...UNKNOWN_BUDGET, reason };
		}
	}

	// Path A: modern probe returns a full SpawnBudget.
	if (probe && typeof probe.getSpawnBudget === "function") {
		try {
			const result = await probe.getSpawnBudget();
			return normaliseBudget(result);
		} catch (err) {
			const reason = err instanceof Error ? err.message : "probe-threw";
			logProbeFailureOnce(reason);
			return { ...UNKNOWN_BUDGET, reason };
		}
	}

	// Path B: legacy probe returns {spawned, cap, activeRuns}.
	if (probe && typeof probe.getBudget === "function") {
		try {
			const raw = probe.getBudget();
			return {
				spawned: raw.spawned,
				cap: raw.cap,
				remaining: Math.max(0, raw.cap - raw.spawned),
				activeRuns: raw.activeRuns,
			};
		} catch (err) {
			const reason = err instanceof Error ? err.message : "legacy-probe-threw";
			logProbeFailureOnce(reason);
			return { ...UNKNOWN_BUDGET, reason };
		}
	}

	logProbeFailureOnce("no-probe-export");
	return { ...UNKNOWN_BUDGET, reason: "no-probe-export" };
}

function normaliseBudget(raw: SpawnBudget): SpawnBudget {
	// If a shape is malformed, coerce to unknown rather than lying to callers.
	const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	if (!isNum(raw.spawned) || !isNum(raw.cap) || !isNum(raw.activeRuns)) {
		return { ...UNKNOWN_BUDGET, reason: "malformed-probe-response" };
	}
	const remaining = isNum(raw.remaining) ? raw.remaining : Math.max(0, raw.cap - raw.spawned);
	return {
		spawned: raw.spawned,
		cap: raw.cap,
		remaining,
		activeRuns: raw.activeRuns,
		...(raw.reason ? { reason: raw.reason } : {}),
	};
}

/**
 * Convenience: format a `SpawnBudget` as a status-line fragment.
 * When any field is `"unknown"`, returns `"spawns: probe-unavailable"`.
 */
export function formatBudgetLine(budget: SpawnBudget): string {
	if (
		budget.spawned === "unknown" ||
		budget.cap === "unknown" ||
		budget.remaining === "unknown" ||
		budget.activeRuns === "unknown"
	) {
		return "spawns: probe-unavailable";
	}
	return `spawns: ${budget.spawned}/${budget.cap} remaining · ${budget.activeRuns} active runs`;
}

// ─── Artifact scanner (P3.5 support) ─────────────────────────────────────

/**
 * A completed subagent artifact whose metadata carries a `taskId` referencing
 * a pi-task task.
 */
export interface TaggedArtifact {
	taskId: string;
	planName?: string;
	artifactPath: string;
	subagentRunId?: string;
	timestamp?: number;
}

let injectedArtifactScan: (() => Promise<TaggedArtifact[]>) | null = null;

/** Test hook: replace the artifact scanner. */
export function _setArtifactScanMock(fn: (() => Promise<TaggedArtifact[]>) | null): void {
	injectedArtifactScan = fn;
}

/**
 * Scan the last N subagent artifacts (default 100) and return those tagged
 * with a `taskId`. When pi-subagents is not available, returns an empty list —
 * never throws.
 *
 * The pi-subagents side of this protocol is documented in P3.4 and not yet
 * implemented; until it is, this function relies on the mock hook. The design
 * doc has the field spec.
 */
export async function scanTaggedArtifacts(): Promise<TaggedArtifact[]> {
	if (injectedArtifactScan) {
		try {
			return await injectedArtifactScan();
		} catch {
			return [];
		}
	}
	// Real implementation: consult pi-subagents' artifact index. Not yet available.
	return [];
}
