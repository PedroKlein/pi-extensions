import { describe, expect, it, vi } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { TIER_SLOTS } from "../src/config.js";
import {
	backendFamilySuffix,
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

function backend(
	name: string,
	tierMap: Record<string, string>,
	extra?: Partial<ResolvedBackend>,
): ResolvedBackend {
	const tiers = new Map();
	for (const [slot, modelId] of Object.entries(tierMap)) {
		tiers.set(slot as (typeof TIER_SLOTS)[number], {
			tierSlot: slot,
			realModelId: modelId,
			realModel: realModel(modelId, name),
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
			tiers: tierMap,
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
	it("two backends with all 5 tiers → 5 neutral + 10 pinned = 15 outputs", () => {
		const backends = [backend("hai-proxy", ALL_TIERS), backend("github-copilot", ALL_TIERS)];
		const input: ComposeInput = {
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => `tok-${b.name}`,
		};
		const { models, warnings } = composeGatewayModels(input);
		expect(warnings).toEqual([]);
		expect(models).toHaveLength(15);
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(
			[
				"heavy-1", "medium-1", "light-1", "xlight-1", "minimal-1",
				"heavy-hai-1", "medium-hai-1", "light-hai-1", "xlight-hai-1", "minimal-hai-1",
				"heavy-copilot-1", "medium-copilot-1", "light-copilot-1", "xlight-copilot-1", "minimal-copilot-1",
			].sort(),
		);
	});

	it("disjoint tier slots: neutral aliases fill from whichever backend has each slot", () => {
		const backends = [
			backend("hai-proxy", { heavy: "hai-heavy", medium: "hai-medium" }),
			backend("github-copilot", { light: "copilot-light", xlight: "copilot-xlight" }),
		];
		const input: ComposeInput = {
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => `tok-${b.name}`,
		};
		const { models, warnings } = composeGatewayModels(input);
		// Neutral: heavy-1, medium-1, light-1, xlight-1 (no minimal — no backend has it)
		// Pinned: 2 hai + 2 copilot = 4
		expect(models).toHaveLength(8);
		expect(models.map((m) => m.id).sort()).toEqual(
			[
				"heavy-1", "medium-1", "light-1", "xlight-1",
				"heavy-hai-1", "medium-hai-1",
				"light-copilot-1", "xlight-copilot-1",
			].sort(),
		);
		// No warning because minimal is simply not declared anywhere.
		expect(warnings).toEqual([]);

		// heavy-1 should route to hai-proxy (first in chain that has it)
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://hai-proxy.example.com");
	});

	it("single-backend: 5 neutral + 5 pinned = 10 outputs", () => {
		const backends = [backend("hai-proxy", ALL_TIERS)];
		const { models } = composeGatewayModels({
			fallbackChain: ["hai-proxy"],
			backends,
			state: emptyState(),
			resolveApiKey: () => "tok",
		});
		expect(models).toHaveLength(10);
	});
});

describe("composeGatewayModels — output shape", () => {
	it("each output has baseUrl, api, headers.Authorization and copies capability fields", () => {
		const backends = [backend("hai-proxy", { heavy: "hai-heavy" })];
		const { models } = composeGatewayModels({
			fallbackChain: ["hai-proxy"],
			backends,
			state: emptyState(),
			resolveApiKey: () => "the-token",
		});
		expect(models).toHaveLength(2);
		for (const m of models) {
			expect(m.baseUrl).toBe("https://hai-proxy.example.com");
			expect(m.api).toBe("openai-completions");
			expect(m.headers.Authorization).toBe("Bearer the-token");
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

describe("composeGatewayModels — fallback chain semantics", () => {
	it("neutral alias picks first HEALTHY backend in chain that has the slot", () => {
		const backends = [
			backend("hai-proxy", { heavy: "hai-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"hai-proxy": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap hit",
				},
			},
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://github-copilot.example.com");
		expect(heavy1?.headers.Authorization).toBe("Bearer tok-github-copilot");
	});

	it("activeBackendOverride reorders the chain", () => {
		const backends = [
			backend("hai-proxy", { heavy: "hai-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const state: GatewayState = {
			...emptyState(),
			activeBackendOverride: "github-copilot",
		};
		const { models } = composeGatewayModels({
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends,
			state,
			resolveApiKey: (b) => `tok-${b.name}`,
		});
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.baseUrl).toBe("https://github-copilot.example.com");
	});

	it("all backends unhealthy → neutral alias for that tier omitted with a warning", () => {
		const backends = [backend("hai-proxy", { heavy: "hai-heavy" })];
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"hai-proxy": {
					until: new Date(Date.now() + 3_600_000).toISOString(),
					reason: "cap",
				},
			},
		};
		const { models, warnings } = composeGatewayModels({
			fallbackChain: ["hai-proxy"],
			backends,
			state,
			resolveApiKey: () => "tok",
		});
		// Family-pinned still emitted; neutral not.
		expect(models.map((m) => m.id)).toEqual(["heavy-hai-1"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("no-healthy-backend-for-tier");
		expect(warnings[0].tierSlot).toBe("heavy");
	});
});

describe("composeGatewayModels — auth resolution failures", () => {
	it("skips a backend when resolveApiKey returns undefined", () => {
		const backends = [
			backend("hai-proxy", { heavy: "hai-heavy" }),
			backend("github-copilot", { heavy: "copilot-heavy" }),
		];
		const { models } = composeGatewayModels({
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends,
			state: emptyState(),
			resolveApiKey: (b) => (b.name === "hai-proxy" ? undefined : "tok"),
		});
		// heavy-1 falls through to copilot; hai family-pinned is dropped for missing token.
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.headers.Authorization).toBe("Bearer tok");
		expect(models.find((m) => m.id === "heavy-hai-1")).toBeUndefined();
		expect(models.find((m) => m.id === "heavy-copilot-1")).toBeDefined();
	});
});

describe("backendFamilySuffix", () => {
	const cases: Array<[string, string]> = [
		["hai-proxy", "hai"],
		["github-copilot", "copilot"],
		["sap-ai-core", "sap"],
		["openai", "openai"],
		["anthropic", "anthropic"],
		["my-corp-api", "corp"],
	];
	for (const [input, expected] of cases) {
		it(`${input} → ${expected}`, () => {
			expect(backendFamilySuffix(input)).toBe(expected);
		});
	}
});

describe("isBackendUnhealthy", () => {
	it("returns false when no entry", () => {
		expect(isBackendUnhealthy("hai-proxy", emptyState())).toBe(false);
	});
	it("returns true when until is in the future", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"hai-proxy": {
					until: new Date(Date.now() + 60_000).toISOString(),
					reason: "cap",
				},
			},
		};
		expect(isBackendUnhealthy("hai-proxy", state)).toBe(true);
	});
	it("returns false when until has expired (lazy healing)", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"hai-proxy": {
					until: new Date(Date.now() - 60_000).toISOString(),
					reason: "cap",
				},
			},
		};
		expect(isBackendUnhealthy("hai-proxy", state)).toBe(false);
	});
});
