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

/**
 * One resolved gateway alias: the neutral id (e.g. `heavy-2`) and the backend
 * + real model it currently routes to. `backend`/`model` are undefined when no
 * healthy backend declares the tier (the alias is emitted but unavailable).
 */
export interface AliasRoute {
	id: string;
	slot: (typeof TIER_SLOTS)[number];
	backend?: string;
	model?: string;
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

/**
 * Resolve every emitted gateway alias to the backend + real model it currently
 * routes to. Shared by the status view, the models view, and (conceptually)
 * the composer's routing logic — kept pure so both text and interactive UIs
 * agree on what an alias points at.
 *
 * The alias count K per tier is fixed by the first backend in the effective
 * order that declares the tier (health-agnostic) so the alias set is stable
 * across cap transitions; routing targets the first HEALTHY backend, clamping
 * the index to that backend's list length.
 */
export function computeAliasRoutes(input: StatusRenderInput): AliasRoute[] {
	const now = input.now ?? new Date();
	const chain = input.state.fallbackChainOverride ?? input.aliases.fallbackChain;
	const active = input.state.activeBackendOverride;
	const ordered: string[] = [];
	if (active) ordered.push(active);
	for (const n of chain) if (!ordered.includes(n)) ordered.push(n);
	for (const n of Object.keys(input.aliases.backends)) if (!ordered.includes(n)) ordered.push(n);

	const routes: AliasRoute[] = [];
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
				routes.push({ id, slot });
				continue;
			}
			const list = input.aliases.backends[picked].tiers[slot]!;
			const model = list[Math.min(n, list.length) - 1];
			routes.push({ id, slot, backend: picked, model });
		}
	}
	return routes;
}

function renderAliases(input: StatusRenderInput, _now: Date): string[] {
	const rows: string[] = [
		"Alias             Routes-to",
		"───────────────── ─────────────────────────────────────────",
	];
	for (const route of computeAliasRoutes(input)) {
		if (!route.backend) {
			rows.push(`${route.id.padEnd(17)} (no healthy backend)`);
			continue;
		}
		rows.push(`${route.id.padEnd(17)} ${route.backend}/${route.model}`);
	}
	return rows;
}

/**
 * Models view rows — one line per gateway alias exposing exactly what the
 * neutral name hides: the real model id and the provider (backend) serving it,
 * plus a live status column. Consumed by both `/gateway models` (text) and the
 * interactive board's models pane.
 */
export function renderModelsRows(input: StatusRenderInput): string[] {
	const rows: string[] = [
		"Alias             Provider            Model                          Status",
		"───────────────── ─────────────────── ────────────────────────────── ──────────",
	];
	const routes = computeAliasRoutes(input);
	if (routes.length === 0) {
		rows.push("(no aliases — check aliases.json backends/tiers)");
		return rows;
	}
	for (const route of routes) {
		if (!route.backend) {
			rows.push(
				`${route.id.padEnd(17)} ${"—".padEnd(19)} ${"—".padEnd(30)} unavailable`,
			);
			continue;
		}
		rows.push(
			`${route.id.padEnd(17)} ${route.backend.padEnd(19)} ${(route.model ?? "").padEnd(30)} healthy`,
		);
	}
	return rows;
}

/** Full text form of the models view for non-interactive (print/RPC) mode. */
export function renderModelsText(input: StatusRenderInput): string {
	return [
		"═══ gateway models ═══════════════════════════════════════════════════─",
		...renderModelsRows(input),
	].join("\n");
}

function renderFooter(): string[] {
	return [
		"[f] force backend   [c] clear overrides   [v] view models",
		"[r] reorder chain   [m] toggle health     [R] reload   [q] quit",
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
