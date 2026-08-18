import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	setActiveOverride,
	setFallbackChainOverride,
	toggleBackendHealth,
	requestReload,
} from "../src/actions.js";
import type { AliasesConfig } from "../src/config.js";
import {
	computeAliasRoutes,
	renderModelsRows,
	renderStatusSections,
	renderStatusText,
} from "../src/status-view.js";
import { emptyState, readState, updateState, writeState, type GatewayState } from "../src/state.js";

const CFG: AliasesConfig = {
	fallbackChain: ["openrouter", "github-copilot"],
	backends: {
		"openrouter": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: ["or-opus", "or-gpt"], light: ["or-light"] },
			quotaHint: "daily-eur-cap",
			capStatusCodes: [402, 429],
		},
		"github-copilot": {
			resetSchedule: "utc-monthly-1st",
			tiers: { heavy: ["copilot-heavy"] },
			quotaHint: undefined,
			capStatusCodes: [402],
		},
	},
};

const NOW = new Date("2025-01-15T12:00:00.000Z");

// -- Status rendering ------------------------------------------------------

describe("renderStatusSections — four sections present", () => {
	it("returns header, backends, aliases, footer", () => {
		const s = renderStatusSections({ aliases: CFG, state: emptyState(), now: NOW });
		expect(s.header.length).toBeGreaterThan(0);
		expect(s.backends.length).toBeGreaterThan(0);
		expect(s.aliases.length).toBeGreaterThan(0);
		expect(s.footer.length).toBeGreaterThan(0);
	});

	it("header names both active override state and effective chain", () => {
		const s = renderStatusSections({
			aliases: CFG,
			state: { ...emptyState(), activeBackendOverride: "github-copilot" },
			now: NOW,
		});
		const joined = s.header.join("\n");
		expect(joined).toContain("github-copilot");
		expect(joined).toContain("openrouter → github-copilot");
	});

	it("backends section shows unhealthy status + reset ETA + quota when present", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: "2025-01-16T00:00:00.000Z",
					reason: "cap",
					quota: { spent: 50.27, cap: 50.0, currency: "EUR" },
				},
			},
		};
		const s = renderStatusSections({ aliases: CFG, state, now: NOW });
		const row = s.backends.find((r) => r.startsWith("openrouter"));
		expect(row).toBeDefined();
		expect(row).toContain("unhealthy");
		expect(row).toMatch(/in \d+h/);
		expect(row).toContain("50.27/50.00 EUR");
	});

	it("aliases section shows indexed neutral rows and no family-pinned rows", () => {
		const s = renderStatusSections({ aliases: CFG, state: emptyState(), now: NOW });
		const ids = s.aliases.filter((r) => /^\w+-/.test(r.trim())).map((r) => r.trim().split(/\s+/)[0]);
		// Indexed diversity from openrouter's 2-model heavy list.
		expect(ids).toContain("heavy-1");
		expect(ids).toContain("heavy-2");
		expect(ids).toContain("light-1");
		// No family-pinned aliases anymore.
		expect(ids.some((id) => /-[a-z]+-1$/.test(id))).toBe(false);
		// heavy-1/heavy-2 route to the two distinct openrouter models.
		const byRow = Object.fromEntries(
			s.aliases
				.filter((r) => /^\w+-\d/.test(r.trim()))
				.map((r) => {
					const [id, route] = r.trim().split(/\s+/);
					return [id, route];
				}),
		);
		expect(byRow["heavy-1"]).toBe("openrouter/or-opus");
		expect(byRow["heavy-2"]).toBe("openrouter/or-gpt");
	});

	it("footer lists all keybindings", () => {
		const s = renderStatusSections({ aliases: CFG, state: emptyState(), now: NOW });
		const footer = s.footer.join("\n");
		for (const key of ["[c]", "[f]", "[r]", "[m]", "[R]", "[q]", "[v]"]) {
			expect(footer).toContain(key);
		}
	});
});

describe("renderStatusText — combined view snapshot", () => {
	it("matches a stable snapshot for the empty-state case", () => {
		const text = renderStatusText({ aliases: CFG, state: emptyState(), now: NOW });
		expect(text).toMatchInlineSnapshot(`
			"═══ gateway ══════════════════════════════════════════════════════════
			Active override: (none — use fallback chain)
			Fallback chain : openrouter → github-copilot

			─── Backends ─────────────────────────────────────────────────────────
			Backend             Health     Resets                Quota
			─────────────────── ────────── ───────────────────── ─────────────────────
			openrouter          healthy                          
			github-copilot      healthy                          

			─── Aliases ──────────────────────────────────────────────────────────
			Alias             Routes-to
			───────────────── ─────────────────────────────────────────
			heavy-1           openrouter/or-opus
			heavy-2           openrouter/or-gpt
			light-1           openrouter/or-light

			─── Keys ─────────────────────────────────────────────────────────────
			[f] force backend   [c] clear overrides   [v] view models
			[r] reorder chain   [m] toggle health     [R] reload   [q] quit"
		`);
	});
});

// -- Alias routes + models view --------------------------------------------

describe("computeAliasRoutes", () => {
	it("maps each indexed alias to its backend + real model", () => {
		const routes = computeAliasRoutes({ aliases: CFG, state: emptyState(), now: NOW });
		const byId = Object.fromEntries(routes.map((r) => [r.id, r]));
		expect(byId["heavy-1"]).toMatchObject({ backend: "openrouter", model: "or-opus" });
		expect(byId["heavy-2"]).toMatchObject({ backend: "openrouter", model: "or-gpt" });
		expect(byId["light-1"]).toMatchObject({ backend: "openrouter", model: "or-light" });
	});

	it("fails over to the next healthy backend when the primary is unhealthy", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": { until: "2025-01-16T00:00:00.000Z", reason: "cap" },
			},
		};
		const byId = Object.fromEntries(
			computeAliasRoutes({ aliases: CFG, state, now: NOW }).map((r) => [r.id, r]),
		);
		// heavy list count stays 2 (openrouter defines it), but routes to copilot,
		// clamped to copilot's single model.
		expect(byId["heavy-1"]).toMatchObject({ backend: "github-copilot", model: "copilot-heavy" });
		expect(byId["heavy-2"]).toMatchObject({ backend: "github-copilot", model: "copilot-heavy" });
		// No backend serves 'light' when openrouter is down.
		expect(byId["light-1"].backend).toBeUndefined();
	});
});

describe("renderModelsRows", () => {
	it("exposes provider + real model per alias", () => {
		const rows = renderModelsRows({ aliases: CFG, state: emptyState(), now: NOW });
		const joined = rows.join("\n");
		expect(joined).toContain("Alias");
		expect(joined).toContain("Provider");
		expect(joined).toContain("Model");
		const heavy1 = rows.find((r) => r.startsWith("heavy-1"));
		expect(heavy1).toContain("openrouter");
		expect(heavy1).toContain("or-opus");
		expect(heavy1).toContain("healthy");
	});

	it("marks aliases unavailable when no healthy backend serves the tier", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": { until: "2025-01-16T00:00:00.000Z", reason: "cap" },
			},
		};
		const rows = renderModelsRows({ aliases: CFG, state, now: NOW });
		const light1 = rows.find((r) => r.startsWith("light-1"));
		expect(light1).toContain("unavailable");
	});
});

// -- Actions ---------------------------------------------------------------

let dir: string;
let statePath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-gateway-actions-"));
	statePath = join(dir, "gateway-state.json");
	writeState(statePath, emptyState());
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("actions — setActiveOverride", () => {
	it("sets and persists activeBackendOverride via atomic writer", () => {
		const result = setActiveOverride(emptyState(), CFG, "github-copilot");
		expect(result.kind).toBe("state-updated");
		if (result.kind !== "state-updated") throw new Error("unreachable");
		const persisted = updateState(statePath, () => result.nextState);
		expect(persisted.activeBackendOverride).toBe("github-copilot");
		expect(readState(statePath).activeBackendOverride).toBe("github-copilot");
	});
	it("throws on unknown backend", () => {
		expect(() => setActiveOverride(emptyState(), CFG, "does-not-exist")).toThrowError(
			/unknown backend/,
		);
	});
	it("clears override when passed undefined", () => {
		const result = setActiveOverride(
			{ ...emptyState(), activeBackendOverride: "openrouter" },
			CFG,
			undefined,
		);
		expect(result.kind).toBe("state-updated");
		if (result.kind !== "state-updated") throw new Error("unreachable");
		expect(result.nextState.activeBackendOverride).toBeUndefined();
	});
});

describe("actions — setFallbackChainOverride", () => {
	it("sets chain override with valid backend list", () => {
		const result = setFallbackChainOverride(emptyState(), CFG, ["github-copilot", "openrouter"]);
		expect(result.kind).toBe("state-updated");
		if (result.kind !== "state-updated") throw new Error("unreachable");
		const persisted = updateState(statePath, () => result.nextState);
		expect(readState(statePath).fallbackChainOverride).toEqual([
			"github-copilot",
			"openrouter",
		]);
	});
	it("throws on unknown entry", () => {
		expect(() =>
			setFallbackChainOverride(emptyState(), CFG, ["openrouter", "ghost"]),
		).toThrowError(/unknown backend/);
	});
	it("throws on empty chain", () => {
		expect(() => setFallbackChainOverride(emptyState(), CFG, [])).toThrowError(
			/cannot be empty/,
		);
	});
});

describe("actions — toggleBackendHealth", () => {
	it("marks a healthy backend unhealthy", () => {
		const until = new Date("2025-01-16T00:00:00.000Z");
		const result = toggleBackendHealth(emptyState(), CFG, "openrouter", until);
		expect(result.kind).toBe("state-updated");
		if (result.kind !== "state-updated") throw new Error("unreachable");
		const persisted = updateState(statePath, () => result.nextState);
		expect(readState(statePath).unhealthyUntil["openrouter"].until).toBe(until.toISOString());
	});
	it("clears unhealthy entry when toggling back", () => {
		const initial: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": { until: "2025-01-16T00:00:00.000Z", reason: "prior" },
			},
		};
		const result = toggleBackendHealth(initial, CFG, "openrouter", new Date());
		expect(result.kind).toBe("state-updated");
		if (result.kind !== "state-updated") throw new Error("unreachable");
		expect(result.nextState.unhealthyUntil["openrouter"]).toBeUndefined();
	});
});

describe("actions — requestReload", () => {
	it("returns reload-requested (state unchanged)", () => {
		const r = requestReload();
		expect(r.kind).toBe("reload-requested");
	});
});
