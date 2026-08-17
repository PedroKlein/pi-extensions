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
	fallbackChain: ["hai-proxy"],
	backends: {
		"hai-proxy": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: "hai/heavy-model", light: "hai/light-model" },
			quotaHint: "hai-daily-eur",
			capStatusCodes: [402, 429],
		},
	},
};

describe("resolveBackends — happy path", () => {
	it("returns full ResolvedBackend shape for a well-configured backend", () => {
		const registry = mockRegistry({
			models: [
				{ id: "hai/heavy-model", provider: "hai-proxy" },
				{ id: "hai/light-model", provider: "hai-proxy" },
			],
			configs: {
				"hai-proxy": {
					apiKey: "!op read op://vault/hai/api-key",
					baseUrl: "https://hai.example.com",
					api: "openai-completions",
				},
			},
		});
		const { backends, warnings } = resolveBackends(HAPPY_CFG, registry);
		expect(warnings).toEqual([]);
		expect(backends).toHaveLength(1);
		const b = backends[0];
		expect(b.name).toBe("hai-proxy");
		expect(b.authMode).toBe("command");
		expect(b.apiKeyRaw).toBe("!op read op://vault/hai/api-key");
		expect(b.baseUrl).toBe("https://hai.example.com");
		expect(b.api).toBe("openai-completions");
		expect(b.tiers.size).toBe(2);
		expect(b.tiers.get("heavy")?.realModelId).toBe("hai/heavy-model");
		expect(b.tiers.get("light")?.realModelId).toBe("hai/light-model");
		expect(b.config.quotaHint).toBe("hai-daily-eur");
		expect(b.config.capStatusCodes).toEqual([402, 429]);
	});
});

describe("resolveBackends — partial failures", () => {
	it("skips an unknown backend and warns", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["hai-proxy", "ghost"],
			backends: {
				"hai-proxy": { tiers: { heavy: "hai/heavy" }, capStatusCodes: [402] },
				ghost: { tiers: { light: "some/model" }, capStatusCodes: [402] },
			},
		};
		const registry = mockRegistry({
			models: [{ id: "hai/heavy", provider: "hai-proxy" }],
			configs: { "hai-proxy": { apiKey: "$HAI_KEY", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		expect(backends.map((b) => b.name)).toEqual(["hai-proxy"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("unknown-backend");
		expect(warnings[0].backend).toBe("ghost");
	});

	it("omits an unknown real model, warns, and keeps other tiers", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["hai-proxy"],
			backends: {
				"hai-proxy": {
					tiers: { heavy: "hai/heavy", light: "hai/does-not-exist" },
					capStatusCodes: [402],
				},
			},
		};
		const registry = mockRegistry({
			models: [{ id: "hai/heavy", provider: "hai-proxy" }],
			configs: { "hai-proxy": { apiKey: "literal-key", api: "openai-completions" } },
		});
		const { backends, warnings } = resolveBackends(cfg, registry);
		expect(backends).toHaveLength(1);
		const b = backends[0];
		expect(b.tiers.size).toBe(1);
		expect(b.tiers.get("heavy")?.realModelId).toBe("hai/heavy");
		expect(b.tiers.has("light")).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("unknown-model");
		expect(warnings[0].realModelId).toBe("hai/does-not-exist");
		expect(warnings[0].tierSlot).toBe("light");
	});
});

describe("classifyAuthMode", () => {
	const cases: Array<[string, string | undefined, string]> = [
		["command: !op read ...", "!op read op://vault/hai/api-key", "command"],
		["command: !echo ...", "!echo hi", "command"],
		["env: $VAR", "$HAI_API_KEY", "env"],
		["env: ${VAR}", "${HAI_API_KEY}", "env"],
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
