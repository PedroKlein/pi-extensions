import { describe, expect, it } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { classifyAuthMode, resolveBackends, type ResolverModelRegistry } from "../src/resolver.js";

// Minimal mock registry.
function mockRegistry(opts: {
	models: Array<{ id: string; provider: string; extra?: Record<string, unknown> }>;
	providers?: Record<string, { id: string; name?: string } | undefined>;
	configs?: Record<
		string,
		{ apiKey?: string; baseUrl?: string; api?: string; oauth?: unknown } | undefined
	>;
}): ResolverModelRegistry {
	return {
		find(provider, id) {
			return opts.models.find((m) => m.provider === provider && m.id === id);
		},
		getProvider(name) {
			if (opts.providers && name in opts.providers) return opts.providers[name];
			// Default: exist if any model has this provider.
			return opts.models.some((m) => m.provider === name) ? { id: name } : undefined;
		},
		getRegisteredProviderConfig(name) {
			return opts.configs?.[name];
		},
		getAll() {
			return opts.models.map((m) => ({ id: m.id, provider: m.provider }));
		},
	};
}

const HAPPY_CFG: AliasesConfig = {
	fallbackChain: ["openrouter"],
	backends: {
		"openrouter": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: ["or/heavy-model"], light: ["or/light-model"] },
			quotaHint: "daily-eur-cap",
			capStatusCodes: [402, 429],
		},
	},
};

describe("resolveBackends — happy path", () => {
	it("returns full ResolvedBackend shape for a well-configured backend", () => {
		const registry = mockRegistry({
			models: [
				{ id: "or/heavy-model", provider: "openrouter" },
				{ id: "or/light-model", provider: "openrouter" },
			],
			configs: {
				"openrouter": {
					apiKey: "!op read op://vault/example/api-key",
					baseUrl: "https://openrouter.example.com",
					api: "openai-completions",
				},
			},
		});
		const { backends, warnings } = resolveBackends(HAPPY_CFG, registry);
		expect(warnings).toEqual([]);
		expect(backends).toHaveLength(1);
		const b = backends[0];
		expect(b.name).toBe("openrouter");
		expect(b.authMode).toBe("command");
		expect(b.apiKeyRaw).toBe("!op read op://vault/example/api-key");
		expect(b.baseUrl).toBe("https://openrouter.example.com");
		expect(b.api).toBe("openai-completions");
		expect(b.tiers.size).toBe(2);
		expect(b.tiers.get("heavy")?.models.map((m) => m.realModelId)).toEqual(["or/heavy-model"]);
		expect(b.tiers.get("light")?.models.map((m) => m.realModelId)).toEqual(["or/light-model"]);
		expect(b.config.quotaHint).toBe("daily-eur-cap");
		expect(b.config.capStatusCodes).toEqual([402, 429]);
	});
});

describe("resolveBackends — partial failures", () => {
	it("skips an unknown backend and warns", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["openrouter", "ghost"],
			backends: {
				"openrouter": { tiers: { heavy: ["or/heavy"] }, capStatusCodes: [402] },
				ghost: { tiers: { light: ["some/model"] }, capStatusCodes: [402] },
			},
		};
		const registry = mockRegistry({
			models: [{ id: "or/heavy", provider: "openrouter" }],
			configs: { "openrouter": { apiKey: "$PROVIDER_KEY", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		expect(backends.map((b) => b.name)).toEqual(["openrouter"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("unknown-backend");
		expect(warnings[0].backend).toBe("ghost");
	});

	it("omits an unknown real model, warns, and keeps other tiers", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["openrouter"],
			backends: {
				"openrouter": {
					tiers: { heavy: ["or/heavy"], light: ["or/does-not-exist"] },
					capStatusCodes: [402],
				},
			},
		};
		const registry = mockRegistry({
			models: [{ id: "or/heavy", provider: "openrouter" }],
			configs: { "openrouter": { apiKey: "literal-key", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		expect(backends).toHaveLength(1);
		const b = backends[0];
		expect(b.tiers.size).toBe(1);
		expect(b.tiers.get("heavy")?.models.map((m) => m.realModelId)).toEqual(["or/heavy"]);
		expect(b.tiers.has("light")).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("unknown-model");
		expect(warnings[0].realModelId).toBe("or/does-not-exist");
		expect(warnings[0].tierSlot).toBe("light");
	});

	it("resolves an ordered list of models per tier (indexed diversity)", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["openrouter"],
			backends: {
				"openrouter": {
					tiers: { heavy: ["or/opus", "or/gpt"] },
					capStatusCodes: [402],
				},
			},
		};
		const registry = mockRegistry({
			models: [
				{ id: "or/opus", provider: "openrouter" },
				{ id: "or/gpt", provider: "openrouter" },
			],
			configs: { "openrouter": { apiKey: "k", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		expect(warnings).toEqual([]);
		const heavy = backends[0].tiers.get("heavy");
		expect(heavy?.models.map((m) => m.realModelId)).toEqual(["or/opus", "or/gpt"]);
	});

	it("drops one unresolvable model from a list but keeps the good ones, preserving order", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["openrouter"],
			backends: {
				"openrouter": {
					tiers: { heavy: ["or/opus", "or/ghost", "or/gpt"] },
					capStatusCodes: [402],
				},
			},
		};
		const registry = mockRegistry({
			models: [
				{ id: "or/opus", provider: "openrouter" },
				{ id: "or/gpt", provider: "openrouter" },
			],
			configs: { "openrouter": { apiKey: "k", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		const heavy = backends[0].tiers.get("heavy");
		expect(heavy?.models.map((m) => m.realModelId)).toEqual(["or/opus", "or/gpt"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].realModelId).toBe("or/ghost");
	});
});

describe("classifyAuthMode", () => {
	const cases: Array<[string, string | undefined, string]> = [
		["command: !op read ...", "!op read op://vault/example/api-key", "command"],
		["command: !echo ...", "!echo hi", "command"],
		["env: $VAR", "$PROVIDER_API_KEY", "env"],
		["env: ${VAR}", "${PROVIDER_API_KEY}", "env"],
		["static: plain literal", "some-static-token", "static"],
		["resolved: apiKey undefined (built-in/OAuth)", undefined, "resolved"],
		["unknown: empty string", "", "unknown"],
	];

	for (const [name, apiKey, expected] of cases) {
		it(`classifies ${name} → ${expected}`, () => {
			expect(classifyAuthMode(apiKey, undefined)).toBe(expected);
		});
	}
});
