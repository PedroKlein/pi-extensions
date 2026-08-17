/**
 * /gateway command actions.
 *
 * Each action is a pure business-logic function operating on the current
 * state; the caller (index.ts) wires it to the atomic state writer and the
 * controller's re-registration path.
 *
 * v1 exposes: change active override, force / clear active override, reorder
 * chain, toggle backend health, reload from disk.
 */

import type { AliasesConfig } from "./config.js";
import type { GatewayState } from "./state.js";

export type ActionResult =
	| { kind: "state-updated"; nextState: GatewayState }
	| { kind: "reload-requested" }
	| { kind: "noop" };

/**
 * Set (or clear) the activeBackendOverride. Pass `undefined` to clear.
 */
export function setActiveOverride(
	state: GatewayState,
	aliases: AliasesConfig,
	backendName: string | undefined,
): ActionResult {
	if (backendName !== undefined && !(backendName in aliases.backends)) {
		throw new Error(
			`unknown backend '${backendName}' — known: ${Object.keys(aliases.backends).join(", ")}`,
		);
	}
	if (state.activeBackendOverride === backendName) return { kind: "noop" };
	return {
		kind: "state-updated",
		nextState: { ...state, activeBackendOverride: backendName },
	};
}

/**
 * Replace the fallback-chain override. Passing `undefined` clears it (falls
 * back to aliases.json). Every entry must name a known backend.
 */
export function setFallbackChainOverride(
	state: GatewayState,
	aliases: AliasesConfig,
	chain: string[] | undefined,
): ActionResult {
	if (chain !== undefined) {
		if (chain.length === 0) throw new Error("chain cannot be empty");
		for (const n of chain) {
			if (!(n in aliases.backends)) {
				throw new Error(`unknown backend '${n}' in chain`);
			}
		}
	}
	return {
		kind: "state-updated",
		nextState: { ...state, fallbackChainOverride: chain },
	};
}

/**
 * Toggle a backend between healthy and unhealthy. Marking healthy removes
 * the entry entirely (equivalent to the P4-T2 sweepExpiries path); marking
 * unhealthy uses `manualUntil` as the reset instant.
 */
export function toggleBackendHealth(
	state: GatewayState,
	aliases: AliasesConfig,
	backendName: string,
	manualUntil: Date,
): ActionResult {
	if (!(backendName in aliases.backends)) {
		throw new Error(`unknown backend '${backendName}'`);
	}
	const nextUnhealthy = { ...state.unhealthyUntil };
	if (backendName in nextUnhealthy) {
		delete nextUnhealthy[backendName];
	} else {
		nextUnhealthy[backendName] = {
			until: manualUntil.toISOString(),
			reason: "manually marked unhealthy",
		};
	}
	return {
		kind: "state-updated",
		nextState: { ...state, unhealthyUntil: nextUnhealthy },
	};
}

/**
 * Request a reload of aliases.json and state.json from disk. The caller
 * (usually index.ts wiring) reads the new files and re-invokes the
 * controller.
 */
export function requestReload(): ActionResult {
	return { kind: "reload-requested" };
}
