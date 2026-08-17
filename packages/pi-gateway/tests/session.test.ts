import { describe, expect, it, vi } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { emptyState, type GatewayState } from "../src/state.js";
import { registerGatewayProvider, type RegistryLike } from "../src/session.js";

function fakeRegistry(
	models: Array<{ id: string; provider: string; [k: string]: unknown }>,
	configs: Record<string, { apiKey?: string; baseUrl?: string; api?: string } | undefined> = {},
	tokens: Record<string, string> = {},
): RegistryLike {
	return {
		find: (p, id) => models.find((m) => m.provider === p && m.id === id),
		getProvider: (n) => (models.some((m) => m.provider === n) ? { id: n } : undefined),
		getRegisteredProviderConfig: (n) => configs[n],
		getAll: () => models.map((m) => ({ id: m.id, provider: m.provider })),
		getApiKeyForProvider: async (n) => tokens[n],
	};
}

describe("registerGatewayProvider — happy path", () => {
	it("calls registerProvider exactly once with name 'gateway'", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["hai-proxy"],
			backends: {
				"hai-proxy": {
					resetSchedule: "utc-midnight",
					tiers: { heavy: ["hai-heavy"], light: ["hai-light"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const registry = fakeRegistry(
			[
				{ id: "hai-heavy", provider: "hai-proxy", contextWindow: 200_000, api: "openai-completions" },
				{ id: "hai-light", provider: "hai-proxy", contextWindow: 128_000, api: "openai-completions" },
			],
			{ "hai-proxy": { apiKey: "!echo hai-token", baseUrl: "https://hai.example" } },
			{ "hai-proxy": "resolved-hai-token" },
		);
		const register = vi.fn();
		const notify = vi.fn();

		const result = await registerGatewayProvider({
			aliases,
			state: emptyState(),
			registry,
			register,
			notify,
		});

		expect(register).toHaveBeenCalledTimes(1);
		expect(register).toHaveBeenCalledWith("gateway", expect.objectContaining({ models: expect.any(Array) }));
		const [_name, cfg] = register.mock.calls[0];
		expect(cfg.models).toHaveLength(2); // 2 indexed neutral aliases (heavy-1, light-1)
		for (const m of cfg.models) {
			expect(m.headers.Authorization).toBe("Bearer resolved-hai-token");
		}
		expect(result.modelsRegistered).toBe(2);
	});
});

describe("registerGatewayProvider — unregistered backend graceful degradation", () => {
	it("registers models from remaining backends and notifies about the missing one", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["hai-proxy", "ghost"],
			backends: {
				"hai-proxy": {
					resetSchedule: undefined,
					tiers: { heavy: ["hai-heavy"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
				ghost: {
					resetSchedule: undefined,
					tiers: { light: ["ghost-light"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		// Only hai-proxy is registered in the fake registry; ghost is missing.
		const registry = fakeRegistry(
			[{ id: "hai-heavy", provider: "hai-proxy", contextWindow: 200_000, api: "openai-completions" }],
			{ "hai-proxy": { apiKey: "!echo hai-token" } },
			{ "hai-proxy": "resolved-hai-token" },
		);
		const register = vi.fn();
		const notify = vi.fn();

		const result = await registerGatewayProvider({
			aliases,
			state: emptyState(),
			registry,
			register,
			notify,
		});

		expect(register).toHaveBeenCalledTimes(1);
		const [_n, cfg] = register.mock.calls[0];
		// Only heavy-1 — light-1 impossible because the only backend that has
		// 'light' (ghost) is unregistered. No family-pinned aliases anymore.
		expect(cfg.models.map((m: { id: string }) => m.id).sort()).toEqual(["heavy-1"]);

		// Notify was called with a warning about ghost.
		const warningCall = notify.mock.calls.find((c) => String(c[0]).includes("ghost"));
		expect(warningCall).toBeDefined();
		expect(warningCall?.[1]).toBe("warning");
		expect(result.resolverWarnings.some((w) => w.backend === "ghost")).toBe(true);
	});
});

describe("registerGatewayProvider — state override respected", () => {
	it("neutral aliases use activeBackendOverride when set", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["hai-proxy", "github-copilot"],
			backends: {
				"hai-proxy": {
					resetSchedule: undefined,
					tiers: { heavy: ["hai-heavy"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
				"github-copilot": {
					resetSchedule: undefined,
					tiers: { heavy: ["copilot-heavy"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const registry = fakeRegistry(
			[
				{ id: "hai-heavy", provider: "hai-proxy", baseUrl: "https://hai.example", api: "x" },
				{ id: "copilot-heavy", provider: "github-copilot", baseUrl: "https://copilot.example", api: "x" },
			],
			{},
			{ "hai-proxy": "hai-tok", "github-copilot": "copilot-tok" },
		);
		const register = vi.fn();
		const state: GatewayState = { ...emptyState(), activeBackendOverride: "github-copilot" };

		await registerGatewayProvider({ aliases, state, registry, register });

		const models = register.mock.calls[0][1].models as Array<{ id: string; headers: Record<string, string> }>;
		const heavy1 = models.find((m) => m.id === "heavy-1");
		expect(heavy1?.headers.Authorization).toBe("Bearer copilot-tok");
	});
});
