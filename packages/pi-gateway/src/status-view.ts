/**
 * Status text renderer.
 *
 * A pure function that turns gateway runtime state into the four
 * conceptual sections defined in the spec:
 *
 *   1. Header       — active backend + effective fallback chain
 *   2. Backends     — table: name / health / reset ETA / quota
 *   3. Aliases      — table: alias id / routes-to / spend
 *   4. Footer       — keybinding legend
 *
 * v1 renders as plain text. A component-based interactive TUI can render
 * the same data with richer widgets; keeping the composition pure lets
 * tests snapshot-check the layout without pulling in the TUI runtime.
 */

import type { AliasesConfig } from "./config.js";
import { TIER_SLOTS } from "./config.js";
import { isBackendUnhealthy } from "./compose.js";
import type { GatewayState } from "./state.js";

export interface StatusRenderInput {
	aliases: AliasesConfig;
	state: GatewayState;
	now?: Date;
}

export interface StatusSections {
	header: string[];
	backends: string[];
	aliases: string[];
	footer: string[];
}

export function renderStatusSections(input: StatusRenderInput): StatusSections {
	const now = input.now ?? new Date();
	return {
		header: renderHeader(input, now),
		backends: renderBackends(input, now),
		aliases: renderAliases(input, now),
		footer: renderFooter(),
	};
}

export function renderStatusText(input: StatusRenderInput): string {
	const s = renderStatusSections(input);
	return [
		"═══ gateway ══════════════════════════════════════════════════════════",
		...s.header,
		"",
		"─── Backends ─────────────────────────────────────────────────────────",
		...s.backends,
		"",
		"─── Aliases ──────────────────────────────────────────────────────────",
		...s.aliases,
		"",
		"─── Keys ─────────────────────────────────────────────────────────────",
		...s.footer,
	].join("\n");
}

function renderHeader(input: StatusRenderInput, _now: Date): string[] {
	const active = input.state.activeBackendOverride;
	const chain =
		input.state.fallbackChainOverride ?? input.aliases.fallbackChain;
	return [
		`Active override: ${active ?? "(none — use fallback chain)"}`,
		`Fallback chain : ${chain.join(" → ")}`,
	];
}

function renderBackends(input: StatusRenderInput, now: Date): string[] {
	const rows: string[] = [
		"Backend             Health     Resets                Quota",
		"─────────────────── ────────── ───────────────────── ─────────────────────",
	];
	for (const name of Object.keys(input.aliases.backends)) {
		const unhealthy = isBackendUnhealthy(name, input.state, now);
		const entry = input.state.unhealthyUntil[name];
		let health: string;
		let eta: string;
		if (unhealthy && entry) {
			health = "unhealthy";
			eta = formatEta(entry.until, now);
		} else {
			health = "healthy";
			eta = "";
		}
		let quota = "";
		if (entry?.quota) {
			quota = `${entry.quota.spent.toFixed(2)}/${entry.quota.cap.toFixed(2)} ${entry.quota.currency}`;
		}
		rows.push(
			`${name.padEnd(19)} ${health.padEnd(10)} ${eta.padEnd(21)} ${quota}`,
		);
	}
	return rows;
}

function renderAliases(input: StatusRenderInput, now: Date): string[] {
	const rows: string[] = [
		"Alias             Routes-to",
		"───────────────── ─────────────────────────────────────────",
	];
	const chain = input.state.fallbackChainOverride ?? input.aliases.fallbackChain;
	const active = input.state.activeBackendOverride;
	const ordered: string[] = [];
	if (active) ordered.push(active);
	for (const n of chain) if (!ordered.includes(n)) ordered.push(n);
	for (const n of Object.keys(input.aliases.backends)) if (!ordered.includes(n)) ordered.push(n);

	// Indexed neutral aliases: <tier>-<N>. The alias count K is set by the first
	// backend in the effective chain that declares the tier (health-agnostic),
	// keeping the alias set stable. Routing targets the first HEALTHY backend,
	// with the index clamped to that backend's list length.
	for (const slot of TIER_SLOTS) {
		// Canonical count from the first backend (any health) declaring the tier.
		let canonicalCount = 0;
		for (const name of ordered) {
			const list = input.aliases.backends[name]?.tiers[slot];
			if (list && list.length > 0) {
				canonicalCount = list.length;
				break;
			}
		}
		if (canonicalCount === 0) continue;

		// First healthy backend that declares the tier.
		let picked: string | undefined;
		for (const name of ordered) {
			const list = input.aliases.backends[name]?.tiers[slot];
			if (!list || list.length === 0) continue;
			if (isBackendUnhealthy(name, input.state, now)) continue;
			picked = name;
			break;
		}

		for (let n = 1; n <= canonicalCount; n++) {
			const id = `${slot}-${n}`;
			if (!picked) {
				rows.push(`${id.padEnd(17)} (no healthy backend)`);
				continue;
			}
			const list = input.aliases.backends[picked].tiers[slot]!;
			const model = list[Math.min(n, list.length) - 1];
			rows.push(`${id.padEnd(17)} ${picked}/${model}`);
		}
	}
	return rows;
}

function renderFooter(): string[] {
	return [
		"[c] change active override    [f] force / clear override",
		"[r] reorder fallback chain    [m] toggle backend health",
		"[R] reload config from disk   [q] quit",
	];
}

function formatEta(untilIso: string, now: Date): string {
	const untilMs = Date.parse(untilIso);
	if (!Number.isFinite(untilMs)) return "unknown";
	const deltaMs = untilMs - now.getTime();
	if (deltaMs <= 0) return "expired";
	const h = Math.floor(deltaMs / 3_600_000);
	const m = Math.floor((deltaMs % 3_600_000) / 60_000);
	if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
	if (h > 0) return `in ${h}h ${m}m`;
	return `in ${m}m`;
}
