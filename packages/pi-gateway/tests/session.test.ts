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
		getProvider: (n) => (models.some((m) => m.provider === n)
			? { id: n, stream: vi.fn(), streamSimple: vi.fn() }
			: undefined),
		getRegisteredProviderConfig: (n) => configs[n],
		getAll: () => models.map((m) => ({ id: m.id, provider: m.provider })),
		getApiKeyForProvider: async (n) => tokens[n],
		getProviderAuth: async (n) => tokens[n]
			? { auth: { apiKey: tokens[n], headers: { "x-backend": n } } }
			: undefined,
	};
}

describe("registerGatewayProvider — happy path", () => {
	it("calls registerProvider exactly once with name 'gateway'", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["openrouter"],
			backends: {
				"openrouter": {
					resetSchedule: "utc-midnight",
					tiers: { heavy: ["or-heavy"], light: ["or-light"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const registry = fakeRegistry(
			[
				{ id: "or-heavy", provider: "openrouter", contextWindow: 200_000, api: "openai-completions" },
				{ id: "or-light", provider: "openrouter", contextWindow: 128_000, api: "openai-completions" },
			],
			{ "openrouter": { apiKey: "!echo or-token", baseUrl: "https://openrouter.example" } },
			{ "openrouter": "resolved-or-token" },
		);
		const register = vi.fn();
		const notify = vi.fn();
		const setRoutes = vi.fn();

		const result = await registerGatewayProvider({
			aliases,
			state: emptyState(),
			registry,
			register,
			notify,
			setRoutes,
		});

		expect(register).toHaveBeenCalledTimes(1);
		expect(register).toHaveBeenCalledWith("gateway", expect.objectContaining({ models: expect.any(Array) }));
		const [_name, cfg] = register.mock.calls[0];
		expect(cfg.models).toHaveLength(2); // 2 indexed neutral aliases (heavy-1, light-1)
		// Auth is provider-level now (pi >= 0.84): a single apiKey for the effective
		// backend, not baked per-model headers.
		expect(cfg.apiKey).toBe("resolved-or-token");
		for (const m of cfg.models) {
			expect(m.headers).toBeUndefined();
			expect(m.api).toBe("gateway"); // routes through the gateway transport
		}
		// Routing targets published to the transport, one per registered alias.
		expect(setRoutes).toHaveBeenCalledTimes(1);
		const publishedTargets = setRoutes.mock.calls[0][0] as Record<string, {
			realApi: string;
			realModelId: string;
			realProvider?: unknown;
			realAuth?: { auth: { apiKey?: string; headers?: Record<string, string> } };
		}>;
		expect(Object.keys(publishedTargets).sort()).toEqual(["heavy-1", "light-1"]);
		expect(publishedTargets["heavy-1"].realModelId).toBe("or-heavy");
		expect(publishedTargets["heavy-1"].realProvider).toBeDefined();
		expect(publishedTargets["heavy-1"].realAuth).toEqual({
			auth: { apiKey: "resolved-or-token", headers: { "x-backend": "openrouter" } },
		});
		expect(result.modelsRegistered).toBe(2);
	});
});

describe("registerGatewayProvider — provider dispatch fallback", () => {
	it("still registers routes when the provider enrichment lookup throws", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["openrouter"],
			backends: {
				openrouter: {
					resetSchedule: undefined,
					tiers: { heavy: ["or-heavy"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const registry = fakeRegistry(
			[{ id: "or-heavy", provider: "openrouter", api: "openai-completions" }],
			{},
			{ openrouter: "resolved-or-token" },
		);
		let lookups = 0;
		registry.getProvider = (name) => {
			lookups++;
			if (lookups > 1) throw new Error("registry temporarily unavailable");
			return { id: name };
		};
		const register = vi.fn();
		const setRoutes = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await expect(registerGatewayProvider({
				aliases,
				state: emptyState(),
				registry,
				register,
				setRoutes,
			})).resolves.toMatchObject({ modelsRegistered: 1 });

			expect(register).toHaveBeenCalledTimes(1);
			const target = setRoutes.mock.calls[0][0]["heavy-1"];
			expect(target.realProvider).toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("provider lookup failed: registry temporarily unavailable"),
			);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("registerGatewayProvider — unregistered backend graceful degradation", () => {
	it("registers models from remaining backends and notifies about the missing one", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["openrouter", "ghost"],
			backends: {
				"openrouter": {
					resetSchedule: undefined,
					tiers: { heavy: ["or-heavy"] },
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
		// Only openrouter is registered in the fake registry; ghost is missing.
		const registry = fakeRegistry(
			[{ id: "or-heavy", provider: "openrouter", contextWindow: 200_000, api: "openai-completions" }],
			{ "openrouter": { apiKey: "!echo or-token" } },
			{ "openrouter": "resolved-or-token" },
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
			fallbackChain: ["openrouter", "github-copilot"],
			backends: {
				"openrouter": {
					resetSchedule: undefined,
					tiers: { heavy: ["or-heavy"] },
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
				{ id: "or-heavy", provider: "openrouter", baseUrl: "https://openrouter.example", api: "x" },
				{ id: "copilot-heavy", provider: "github-copilot", baseUrl: "https://copilot.example", api: "x" },
			],
			{},
			{ "openrouter": "or-tok", "github-copilot": "copilot-tok" },
		);
		const register = vi.fn();
		const state: GatewayState = { ...emptyState(), activeBackendOverride: "github-copilot" };

		await registerGatewayProvider({ aliases, state, registry, register });

		const cfg = register.mock.calls[0][1] as { apiKey?: string; models: Array<{ id: string }> };
		const heavy1 = cfg.models.find((m) => m.id === "heavy-1");
		expect(heavy1).toBeDefined();
		// activeBackendOverride routes all aliases to github-copilot, so the
		// provider-level credential is copilot's token.
		expect(cfg.apiKey).toBe("copilot-tok");
	});
});

describe("registerGatewayProvider — multi-backend degradation", () => {
	it("disjoint tiers span two backends: serves the primary and warns about the rest", async () => {
		const aliases: AliasesConfig = {
			fallbackChain: ["openrouter", "github-copilot"],
			backends: {
				"openrouter": {
					resetSchedule: undefined,
					tiers: { heavy: ["or-heavy"], medium: ["or-medium"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
				"github-copilot": {
					resetSchedule: undefined,
					tiers: { light: ["copilot-light"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const registry = fakeRegistry(
			[
				{ id: "or-heavy", provider: "openrouter", baseUrl: "https://openrouter.example", api: "x" },
				{ id: "or-medium", provider: "openrouter", baseUrl: "https://openrouter.example", api: "x" },
				{ id: "copilot-light", provider: "github-copilot", baseUrl: "https://copilot.example", api: "x" },
			],
			{},
			{ "openrouter": "or-tok", "github-copilot": "copilot-tok" },
		);
		const register = vi.fn();
		const notify = vi.fn();

		const result = await registerGatewayProvider({ aliases, state: emptyState(), registry, register, notify });

		const cfg = register.mock.calls[0][1] as { apiKey?: string; models: Array<{ id: string }> };
		// Only openrouter (primary, first in chain) aliases are registered.
		expect(cfg.models.map((m) => m.id).sort()).toEqual(["heavy-1", "medium-1"]);
		expect(cfg.apiKey).toBe("or-tok");
		expect(result.modelsRegistered).toBe(2);
		// A warning explains the omission of github-copilot.
		const warn = notify.mock.calls.find((c) => String(c[0]).includes("multiple backends"));
		expect(warn).toBeDefined();
		expect(warn?.[1]).toBe("warning");
	});
});
