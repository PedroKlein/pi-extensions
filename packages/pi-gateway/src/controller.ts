/**
 * Runtime controller: owns live gateway state, debounces re-registrations,
 * and emits user-visible notifications.
 *
 * The controller is intentionally a small class rather than free functions
 * because it holds mutable state (a debounce flag and the latest state
 * snapshot). All the pure logic — composition, cap detection — lives in
 * `compose.ts` and `detect.ts`; the controller only wires them together.
 */

import type { AliasesConfig } from "./config.js";
import { applyCapOutcome, classifyCapEvent, type CapEventInput } from "./detect.js";
import { registerGatewayProvider, type RegisterFn, type RegistryLike } from "./session.js";
import { emptyState, readState, updateState, type GatewayState } from "./state.js";
import { isBackendUnhealthy } from "./compose.js";
import { TIER_SLOTS } from "./config.js";

export interface ControllerOptions {
	aliases: AliasesConfig;
	statePath: string;
	registry: RegistryLike;
	register: RegisterFn;
	notify: (msg: string, type?: "info" | "warning" | "error") => void;
	/** Testable clock. */
	now?: () => Date;
	/** Testable microtask deferral. */
	scheduleMicrotask?: (fn: () => void) => void;
}

/**
 * The controller manages the "live" gateway routing: it holds a snapshot
 * of the current state, debounces re-registrations, and emits user notices
 * on health-state transitions.
 */
export class GatewayController {
	private state: GatewayState;
	private dirty = false;
	private previousUnhealthy: Record<string, string> = {};
	/** alias id → backend name from the most recent compose. Cap attribution
	 * for backend-agnostic indexed aliases relies on this. */
	private routing: Record<string, string> = {};
	private readonly opts: Required<Omit<ControllerOptions, "now" | "scheduleMicrotask">> & {
		now: () => Date;
		scheduleMicrotask: (fn: () => void) => void;
	};

	constructor(opts: ControllerOptions) {
		this.opts = {
			aliases: opts.aliases,
			statePath: opts.statePath,
			registry: opts.registry,
			register: opts.register,
			notify: opts.notify,
			now: opts.now ?? (() => new Date()),
			scheduleMicrotask: opts.scheduleMicrotask ?? ((fn) => queueMicrotask(fn)),
		};
		this.state = readState(this.opts.statePath);
		this.previousUnhealthy = snapshotUnhealthy(this.state);
	}

	getState(): GatewayState {
		return this.state;
	}

	/**
	 * Handle a `message_end` event. Classifies as cap-hit or not; if it's a
	 * cap hit, persists the transition atomically, schedules a debounced
	 * re-registration, and returns true.
	 */
	handleMessageEnd(event: CapEventInput): boolean {
		const outcome = classifyCapEvent(event, this.opts.aliases, this.opts.now(), this.routing);
		if (!outcome.capHit || !outcome.backendName || !outcome.entry) return false;

		this.state = updateState(this.opts.statePath, (cur) =>
			applyCapOutcome(cur, outcome.backendName!, outcome.entry!),
		);
		this.scheduleReregister();
		return true;
	}

	/**
	 * Sweep expired unhealthy entries and re-register if any changed. Called
	 * lazily by callers who need fresh routing (e.g. before each request).
	 * Returns `true` when at least one backend was healed.
	 */
	sweepExpiries(): boolean {
		const now = this.opts.now();
		const currentlyUnhealthy = Object.entries(this.state.unhealthyUntil).filter(([, e]) =>
			Date.parse(e.until) > now.getTime(),
		);
		if (currentlyUnhealthy.length === Object.keys(this.state.unhealthyUntil).length) {
			return false;
		}
		this.state = updateState(this.opts.statePath, (cur) => {
			const kept: Record<string, GatewayState["unhealthyUntil"][string]> = {};
			for (const [name, entry] of Object.entries(cur.unhealthyUntil)) {
				if (Date.parse(entry.until) > now.getTime()) kept[name] = entry;
			}
			return { ...cur, unhealthyUntil: kept };
		});
		this.scheduleReregister();
		return true;
	}

	/**
	 * Force a re-registration (e.g. after user edits state via /gateway TUI).
	 */
	requestReregister(): void {
		this.scheduleReregister();
	}

	/**
	 * Reload state from disk (e.g. after /gateway reload) and re-register.
	 */
	reloadStateFromDisk(): void {
		this.state = readState(this.opts.statePath);
		this.scheduleReregister();
	}

	private scheduleReregister(): void {
		if (this.dirty) return;
		this.dirty = true;
		this.opts.scheduleMicrotask(() => {
			this.dirty = false;
			void this.reregisterNow();
		});
	}

	private async reregisterNow(): Promise<void> {
		const previous = this.previousUnhealthy;
		const current = snapshotUnhealthy(this.state);
		this.previousUnhealthy = current;

		try {
			const result = await registerGatewayProvider({
				aliases: this.opts.aliases,
				state: this.state,
				registry: this.opts.registry,
				register: this.opts.register,
				now: this.opts.now,
			});
			this.routing = result.routing;
		} catch (err) {
			this.opts.notify(`gateway re-registration failed: ${(err as Error).message}`, "error");
			return;
		}

		// Emit user-visible notices for each transition.
		this.emitTransitionNotices(previous, current);
	}

	private emitTransitionNotices(
		previous: Record<string, string>,
		current: Record<string, string>,
	): void {
		// Newly unhealthy backends.
		for (const [name, until] of Object.entries(current)) {
			if (previous[name] === until) continue;
			const eta = formatEta(until, this.opts.now());
			this.opts.notify(`gateway: ${name} unhealthy — resets ${eta}`, "warning");
		}
		// Newly healthy backends.
		for (const [name] of Object.entries(previous)) {
			if (!(name in current)) {
				this.opts.notify(`gateway: ${name} healthy again`, "info");
			}
		}
		// All-down check: any tier with no healthy backend?
		const affectedTiers = this.tiersWithNoHealthyBackend();
		for (const slot of affectedTiers) {
			this.opts.notify(
				`gateway: no healthy backend for tier '${slot}' — neutral alias '${slot}-1' unavailable`,
				"error",
			);
		}
	}

	private tiersWithNoHealthyBackend(): string[] {
		const affected: string[] = [];
		for (const slot of TIER_SLOTS) {
			const anyDeclared = Object.values(this.opts.aliases.backends).some(
				(b) => slot in b.tiers,
			);
			if (!anyDeclared) continue;
			const anyHealthy = Object.entries(this.opts.aliases.backends).some(
				([name, b]) =>
					slot in b.tiers && !isBackendUnhealthy(name, this.state, this.opts.now()),
			);
			if (!anyHealthy) affected.push(slot);
		}
		return affected;
	}
}

function snapshotUnhealthy(state: GatewayState): Record<string, string> {
	const snap: Record<string, string> = {};
	for (const [name, e] of Object.entries(state.unhealthyUntil)) {
		snap[name] = e.until;
	}
	return snap;
}

function formatEta(untilIso: string, now: Date): string {
	const untilMs = Date.parse(untilIso);
	if (!Number.isFinite(untilMs)) return "unknown";
	const deltaMs = untilMs - now.getTime();
	if (deltaMs <= 0) return "now";
	const hours = Math.floor(deltaMs / 3_600_000);
	const minutes = Math.floor((deltaMs % 3_600_000) / 60_000);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		return `in ${days}d ${hours % 24}h`;
	}
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}
