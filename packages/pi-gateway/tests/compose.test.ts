import { describe, expect, it, vi } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { TIER_SLOTS } from "../src/config.js";
import {
	composeGatewayModels,
	isBackendUnhealthy,
	type ComposeInput,
} from "../src/compose.js";
import type { ResolvedBackend } from "../src/resolver.js";
import { emptyState, type GatewayState } from "../src/state.js";

// -- Fixtures ---------------------------------------------------------------

function realModel(id: string, provider: string, extra?: Record<string, unknown>) {
	return {
		id,
		provider,
		name: `${id} name`,
		baseUrl: `https://${provider}.example.com`,
		api: "openai-completions",
		contextWindow: 200_000,
		maxTokens: 8_000,
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: false,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null },
		compat: { supportsDeveloperRole: false },
		...extra,
	};
}

// tierMap values may be a single model id or an ordered list of ids.
function backend(
	name: string,
	tierMap: Record<string, string | string[]>,
	extra?: Partial<ResolvedBackend>,
): ResolvedBackend {
	const tiers = new Map();
	const cfgTiers: Record<string, string[]> = {};
	for (const [slot, value] of Object.entries(tierMap)) {
		const ids = Array.isArray(value) ? value : [value];
		cfgTiers[slot] = ids;
		tiers.set(slot as (typeof TIER_SLOTS)[number], {
			tierSlot: slot,
			models: ids.map((id) => ({ realModelId: id, realModel: realModel(id, name) })),
		});
	}
	return {
		name,
		authMode: "command",
		apiKeyRaw: `!echo ${name}-key`,
		baseUrl: `https://${name}.example.com`,
		api: "openai-completions",
		tiers,
		config: {
			resetSchedule: "utc-midnight",
			tiers: cfgTiers,
			quotaHint: undefined,
			capStatusCodes: [402, 429],
		},
		...extra,
	};
}

const ALL_TIERS = {
	heavy: "heavy-real",
	medium: "medium-real",
	light: "light-real",
	xlight: "xlight-real",
	minimal: "minimal-real",
};

// -- Tests ------------------------------------------------------------------

describe("composeGatewayModels — output counts", () => {
	it("two backends, all single-model tiers → 5 indexed neutral aliases (no family-pinned)", () => {
		const backends = [backend("openrouter", ALL_TIERS), backend("github-copilot", ALL_TIERS)];
		const input: ComposeInput = {
			fallbackChain: ["openrouter", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => `tok-${b.name}`,
		};
		const { models, warnings } = composeGatewayModels(input);
		expect(warnings).toEqual([]);
		expect(models).toHaveLength(5);
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(
			["heavy-1", "medium-1", "light-1", "xlight-1", "minimal-1"].sort(),
		);
		// No family-pinned aliases (e.g. heavy-<backend>-1) are emitted anymore.
		expect(models.some((m) => /-[a-z]+-1$/.test(m.id))).toBe(false);
		// heavy-1 routes to the primary backend (openrouter).
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://openrouter.example.com");
	});

	it("indexed diversity within one backend: heavy list [opus, gpt] → heavy-1, heavy-2", () => {
		const backends = [
			backend("openrouter", { heavy: ["opus", "gpt"], light: ["haiku", "mini"] }),
		];
		const { models, warnings } = composeGatewayModels({
			fallbackChain: ["openrouter"],
			backends,
			state: emptyState(),
			resolveApiKey: () => "tok",
		});
		expect(warnings).toEqual([]);
		expect(models.map((m) => m.id).sort()).toEqual(
			["heavy-1", "heavy-2", "light-1", "light-2"].sort(),
		);
		// Each alias carries its own underlying model's capabilities. The mock's
		// realModel(id).name is `${id} name`, which proves index→model routing.
		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		expect(byId["heavy-1"].name).toBe("opus name");
		expect(byId["heavy-2"].name).toBe("gpt name");
		expect(byId["light-1"].name).toBe("haiku name");
		expect(byId["light-2"].name).toBe("mini name");
	});

	it("disjoint tier slots: neutral aliases fill from whichever backend has each slot", () => {
		const backends = [
			backend("openrouter", { heavy: "or-heavy", medium: "or-medium" }),
			backend("github-copilot", { light: "copilot-light", xlight: "copilot-xlight" }),
		];
		const input: ComposeInput = {
			fallbackChain: ["openrouter", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => `tok-${b.name}`,
		};
		const { models, warnings } = composeGatewayModels(input);
		// Neutral only: heavy-1, medium-1 (from openrouter), light-1, xlight-1 (from copilot).
		// No minimal — no backend declares it. No family-pinned aliases.
		expect(models).toHaveLength(4);
		expect(models.map((m) => m.id).sort()).toEqual(
			["heavy-1", "medium-1", "light-1", "xlight-1"].sort(),
		);
		// No warning because minimal is simply not declared anywhere.
		expect(warnings).toEqual([]);

		// heavy-1 should route to openrouter (first in chain that has it)
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://openrouter.example.com");
	});

	it("single-backend, single-model tiers: 5 indexed neutral aliases", () => {
		const backends = [backend("openrouter", ALL_TIERS)];
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter"],
			backends,
			state: emptyState(),
			resolveApiKey: () => "tok",
		});
		expect(models).toHaveLength(5);
		expect(models.some((m) => /-[a-z]+-1$/.test(m.id))).toBe(false);
	});
});

describe("composeGatewayModels — output shape", () => {
	it("each output has baseUrl, api and copies capability fields (no baked auth headers)", () => {
		const backends = [backend("openrouter", { heavy: "or-heavy" })];
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter"],
			backends,
			state: emptyState(),
			resolveApiKey: () => "the-token",
		});
		expect(models).toHaveLength(1);
		for (const m of models) {
			expect(m.baseUrl).toBe("https://openrouter.example.com");
			expect(m.api).toBe("openai-completions");
			// Auth is provider-level now; entries carry no Authorization header.
			expect(m.headers).toBeUndefined();
			// Capability fields
			expect(m.contextWindow).toBe(200_000);
			expect(m.maxTokens).toBe(8_000);
			expect(m.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
			expect(m.input).toEqual(["text", "image"]);
			expect(m.reasoning).toBe(false);
			expect(m.thinkingLevelMap).toBeDefined();
			expect(m.compat).toBeDefined();
		}
	});
});

describe("composeGatewayModels — indexed failover fallthrough", () => {
	it("primary capped → heavy-2 routes to the secondary backend's list position 2", () => {
		const backends = [
			backend("openrouter", { heavy: ["or-opus", "or-gpt"] }),
			backend("groq", { heavy: ["gq-opus", "gq-gpt"] }),
		];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap",
				},
			},
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter", "groq"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		// Both indexed aliases now served by the healthy secondary backend.
		expect(byId["heavy-1"].name).toBe("gq-opus name");
		expect(byId["heavy-2"].name).toBe("gq-gpt name");
		expect(byId["heavy-1"].baseUrl).toBe("https://groq.example.com");
	});

	it("alias count is stable (set by primary); index clamps when router has fewer models", () => {
		// Primary declares 2 heavy models → canonical alias set is heavy-1, heavy-2.
		// Secondary declares only 1. When the primary is capped, BOTH aliases stay
		// referenceable: heavy-2 clamps to the secondary's single (last/best) model
		// so a caller pinned to gateway/heavy-2 keeps working.
		const backends = [
			backend("openrouter", { heavy: ["or-opus", "or-gpt"] }),
			backend("groq", { heavy: ["gq-only"] }),
		];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap",
				},
			},
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter", "groq"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(["heavy-1", "heavy-2"]);
		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		// Both clamp to the secondary's only model.
		expect(byId["heavy-1"].name).toBe("gq-only name");
		expect(byId["heavy-2"].name).toBe("gq-only name");
		expect(byId["heavy-2"].baseUrl).toBe("https://groq.example.com");
	});
});

describe("composeGatewayModels — fallback chain semantics", () => {
	it("neutral alias picks first HEALTHY backend in chain that has the slot", () => {
		const backends = [
			backend("openrouter", { heavy: "or-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap hit",
				},
			},
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter", "github-copilot"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://github-copilot.example.com");
	});

	it("activeBackendOverride reorders the chain", () => {
		const backends = [
			backend("openrouter", { heavy: "or-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const state: GatewayState = {
			...emptyState(),
			activeBackendOverride: "github-copilot",
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter", "github-copilot"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://github-copilot.example.com");
	});

	it("all backends unhealthy → neutral alias for that tier omitted with a warning", () => {
		const backends = [backend("openrouter", { heavy: "or-heavy" })];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap",
				},
			},
		};
		const { models, warnings } = composeGatewayModels({
			fallbackChain: ["openrouter"],
			backends,
			state,
			resolveApiKey: () => "tok",
		});
		// No family-pinned fallback anymore: the only backend is unhealthy, so
		// no aliases are emitted and a warning is produced.
		expect(models).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("no-healthy-backend-for-tier");
		expect(warnings[0].tierSlot).toBe("heavy");
	});
});

describe("composeGatewayModels — auth resolution failures", () => {
	it("skips a backend when resolveApiKey returns undefined", () => {
		const backends = [
			backend("openrouter", { heavy: "or-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const { models } = composeGatewayModels({
			fallbackChain: ["openrouter", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => (b.name === "openrouter" ? undefined : "tok"),
		});
		// heavy-1 falls through to copilot; openrouter contributes nothing (no token).
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://github-copilot.example.com");
	});
});

describe("isBackendUnhealthy", () => {
	it("returns false when no entry", () => {
		expect(isBackendUnhealthy("openrouter", emptyState())).toBe(false);
	});
	it("returns true when until is in the future", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() + 60_000).toISOString(),
					reason: "cap",
				},
			},
		};
		expect(isBackendUnhealthy("openrouter", state)).toBe(true);
	});
	it("returns false when until has expired (lazy healing)", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date(Date.now() - 60_000).toISOString(),
					reason: "cap",
				},
			},
		};
		expect(isBackendUnhealthy("openrouter", state)).toBe(false);
	});
});
