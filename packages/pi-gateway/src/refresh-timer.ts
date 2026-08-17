/**
 * Periodic token-refresh timer.
 *
 * Every gateway model entry embeds a literal `Bearer <resolved-token>`
 * header (per P0-T3 divergence). For backends where the underlying token
 * can change over time — OAuth refreshes, env-var updates, `!command`
 * rotations — that literal goes stale unless we periodically re-fetch
 * and re-register.
 *
 * This timer runs only when at least one backend has a non-`static`
 * authMode. It calls a caller-provided `onTick` (which triggers
 * controller.requestReregister()), defers when the agent is streaming
 * (`isIdle()` returns false), and retries on the next tick.
 *
 * Configurable interval via PI_GATEWAY_OAUTH_REFRESH_MS (default 30min).
 */

import type { ResolvedBackend } from "./resolver.js";

export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface RefreshTimerOptions {
	backends: readonly ResolvedBackend[];
	intervalMs?: number;
	isIdle: () => boolean;
	onTick: () => Promise<void> | void;
	/** Testable timer surface. Default uses node's setInterval / clearInterval. */
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export interface RefreshTimerHandle {
	stop(): void;
	/** True when a timer is actually running. */
	readonly installed: boolean;
}

/**
 * Install a periodic refresh timer iff at least one backend has a
 * non-static authMode. Returns a handle with .stop() and .installed.
 */
export function installRefreshTimer(opts: RefreshTimerOptions): RefreshTimerHandle {
	const needsTimer = opts.backends.some((b) => b.authMode !== "static");
	if (!needsTimer) {
		return { stop: () => {}, installed: false };
	}
	const intervalMs = opts.intervalMs ?? parseIntervalEnv();
	const setIntervalFn = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h as never));

	const handle = setIntervalFn(() => {
		void tick(opts);
	}, intervalMs);

	return {
		stop: () => clearIntervalFn(handle),
		installed: true,
	};
}

async function tick(opts: RefreshTimerOptions): Promise<void> {
	if (!opts.isIdle()) {
		// Defer — next tick will retry. Idle-check is intentionally cheap and
		// synchronous so we don't accidentally serialize agent turns.
		return;
	}
	try {
		await opts.onTick();
	} catch {
		// Swallow errors; next tick retries.
	}
}

function parseIntervalEnv(): number {
	const raw = process.env.PI_GATEWAY_OAUTH_REFRESH_MS;
	if (!raw) return DEFAULT_REFRESH_INTERVAL_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1000) return DEFAULT_REFRESH_INTERVAL_MS;
	return n;
}
