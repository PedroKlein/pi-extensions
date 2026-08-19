import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayModelEntry } from "../src/compose.js";

// Capture calls into the mocked oh-my-pi/pi-ai so we can assert the gateway
// transport registers a custom api and delegates the swapped-in real model to
// the top-level dispatcher.
const calls = vi.hoisted(() => ({
	registerCustomApi: [] as Array<{ api: string; streamSimple: any; sourceId?: string; stream?: any }>,
	stream: [] as Array<{ model: any; context: any; options: any }>,
	streamSimple: [] as Array<{ model: any; context: any; options: any }>,
}));

vi.mock("@oh-my-pi/pi-ai", () => ({
	registerCustomApi: (api: string, streamSimple: any, sourceId?: string, stream?: any) => {
		calls.registerCustomApi.push({ api, streamSimple, sourceId, stream });
	},
	stream: (model: any, context: any, options: any) => {
		calls.stream.push({ model, context, options });
		return "STREAM_RESULT";
	},
	streamSimple: (model: any, context: any, options: any) => {
		calls.streamSimple.push({ model, context, options });
		return "STREAM_SIMPLE_RESULT";
	},
}));

import { adaptOmpRegistry, createOmpGatewayTransport, ompRegisterProvider, toOmpModels } from "../src/omp-platform.js";
import { resolveBackends } from "../src/resolver.js";

beforeEach(() => {
	calls.registerCustomApi.length = 0;
	calls.stream.length = 0;
	calls.streamSimple.length = 0;
});

const route = {
	"heavy-1": {
		realApi: "custom-api",
		realModelId: "anthropic--claude-sonnet-4",
		realBaseUrl: "https://custom.example/v2",
		realModel: {
			id: "anthropic--claude-sonnet-4",
			api: "custom-api",
			baseUrl: "https://custom.example/v2",
			contextWindow: 200000,
		},
	},
};

describe("createOmpGatewayTransport", () => {
	it("register() is a no-op (custom api registered via registerProvider instead)", () => {
		const t = createOmpGatewayTransport();
		t.register();
		t.register(); // idempotent
		expect(calls.registerCustomApi).toHaveLength(0);
	});

	it("delegates streamSimple with the REAL model id/api/baseUrl (not the alias)", () => {
		const t = createOmpGatewayTransport();
		t.setRoutes(route);

		const out = t.streamSimple({ id: "heavy-1", api: "gateway" }, { ctx: 1 }, { apiKey: "svc-key" });
		expect(out).toBe("STREAM_SIMPLE_RESULT");
		expect(calls.streamSimple).toHaveLength(1);
		const delivered = calls.streamSimple[0].model;
		expect(delivered.id).toBe("anthropic--claude-sonnet-4"); // wire name, not "heavy-1"
		expect(delivered.api).toBe("custom-api");
		expect(delivered.baseUrl).toBe("https://custom.example/v2");
		expect(calls.streamSimple[0].options).toEqual({ apiKey: "svc-key" });
	});

	it("delegates the full stream path too", () => {
		const t = createOmpGatewayTransport();
		t.setRoutes(route);
		const out = t.stream({ id: "heavy-1", api: "gateway" }, {}, {});
		expect(out).toBe("STREAM_RESULT");
		expect(calls.stream[0].model.id).toBe("anthropic--claude-sonnet-4");
	});

	it("dispatches extension-registered custom APIs without using OMP's isolated top-level registry", () => {
		const customStream = vi.fn(() => "CUSTOM_STREAM_RESULT");
		const customStreamSimple = vi.fn(() => "CUSTOM_STREAM_SIMPLE_RESULT");
		const t = createOmpGatewayTransport((api) =>
			api === "custom-api"
				? { stream: customStream, streamSimple: customStreamSimple }
				: undefined,
		);
		t.setRoutes(route);

		expect(t.stream({ id: "heavy-1", api: "gateway" }, { ctx: 1 }, { apiKey: "key" })).toBe(
			"CUSTOM_STREAM_RESULT",
		);
		expect(
			t.streamSimple({ id: "heavy-1", api: "gateway" }, { ctx: 2 }, { apiKey: "key" }),
		).toBe("CUSTOM_STREAM_SIMPLE_RESULT");
		expect(calls.stream).toHaveLength(0);
		expect(calls.streamSimple).toHaveLength(0);
		expect(customStream.mock.calls[0][0]).toMatchObject({
			id: "anthropic--claude-sonnet-4",
			api: "custom-api",
		});
	});

	it("throws a clear error for a stale alias", () => {
		const t = createOmpGatewayTransport();
		t.setRoutes({}); // no routes
		expect(() => t.streamSimple({ id: "ghost", api: "gateway" }, {}, {})).toThrow(/no route for 'ghost'/);
	});
});

describe("toOmpModels", () => {
	it("drops per-model baseUrl and pins api=gateway", () => {
		const models: GatewayModelEntry[] = [
			{ id: "heavy-1", name: "heavy-1", api: "gateway", baseUrl: "https://x", contextWindow: 200000 },
		];
		const out = toOmpModels(models);
		expect(out[0].id).toBe("heavy-1");
		expect(out[0].api).toBe("gateway");
		expect("baseUrl" in out[0]).toBe(false);
		expect(out[0].contextWindow).toBe(200000);
	});
});

describe("ompRegisterProvider", () => {
	it("maps the neutral config onto oh-my-pi registerProvider (literal apiKey, provider baseUrl, streamSimple)", () => {
		const captured: Array<{ name: string; cfg: any }> = [];
		const t = createOmpGatewayTransport();
		t.setRoutes(route);
		const reg = ompRegisterProvider({ registerProvider: (name, cfg) => captured.push({ name, cfg }) }, t);
		reg("gateway", {
			models: [{ id: "heavy-1", name: "heavy-1", api: "gateway", baseUrl: "https://x", contextWindow: 1 }],
			apiKey: "$opaque!token", // must be passed literally, NOT escaped
			baseUrl: "https://custom.example/v2",
		});
		expect(captured).toHaveLength(1);
		const { name, cfg } = captured[0];
		expect(name).toBe("gateway");
		expect(cfg.api).toBe("gateway");
		expect(cfg.baseUrl).toBe("https://custom.example/v2");
		expect(cfg.apiKey).toBe("$opaque!token");
		expect(cfg.models[0].api).toBe("gateway");
		expect("baseUrl" in cfg.models[0]).toBe(false);
		// The provider carries the routed streamSimple delegate (so oh-my-pi's
		// internal registerCustomApi wires the gateway api). It swaps alias→real.
		expect(typeof cfg.streamSimple).toBe("function");
		const out = cfg.streamSimple({ id: "heavy-1", api: "gateway" }, {}, {});
		expect(out).toBe("STREAM_SIMPLE_RESULT");
		expect(calls.streamSimple[0].model.id).toBe("anthropic--claude-sonnet-4");
	});

	it("falls back to a valid placeholder baseUrl when none is provided", () => {
		const captured: Array<{ name: string; cfg: any }> = [];
		const reg = ompRegisterProvider(
			{ registerProvider: (name, cfg) => captured.push({ name, cfg }) },
			createOmpGatewayTransport(),
		);
		reg("gateway", { models: [] });
		expect(() => new URL(captured[0].cfg.baseUrl)).not.toThrow();
	});
});

describe("adaptOmpRegistry", () => {
	// A faithful oh-my-pi ModelRegistry: only the methods oh-my-pi actually
	// exposes. Crucially it has NO getProvider / getRegisteredProviderConfig —
	// the exact gap that crashed session_start ("registry.getProvider is not a
	// function"). If the adapter ever leaks a pi-only call onto this object, the
	// missing method throws and this test fails.
	function makeOmpRegistry() {
		const models = [
			{ provider: "custom-api", id: "gpt-4o", api: "custom-api" },
			{ provider: "custom-api", id: "claude-3-7-sonnet", api: "custom-api" },
		];
		return {
			find: (provider: string, modelId: string) =>
				models.find((m) => m.provider === provider && m.id === modelId),
			getAll: () => models,
			hasProvider: (p: string) => models.some((m) => m.provider === p),
			getProviderBaseUrl: (p: string) =>
				p === "custom-api" ? "https://real.example/v2" : undefined,
			getApiKeyForProvider: async (p: string) =>
				p === "custom-api" ? "tok-123" : undefined,
		};
	}

	it("resolveBackends works through the adapter (no pi-only registry methods)", () => {
		const reg = adaptOmpRegistry(makeOmpRegistry());
		const config = {
			fallbackChain: ["custom-api"],
			backends: {
				"custom-api": { tiers: { "heavy-1": ["gpt-4o"], "medium-1": ["claude-3-7-sonnet"] } },
			},
		} as any;
		const { backends, warnings } = resolveBackends(config, reg);
		expect(warnings).toEqual([]);
		expect(backends).toHaveLength(1);
		expect(backends[0].name).toBe("custom-api");
		expect(backends[0].baseUrl).toBe("https://real.example/v2");
		expect(backends[0].api).toBe("custom-api");
		// tiers resolved to real models
		expect([...backends[0].tiers.keys()].sort()).toEqual(["heavy-1", "medium-1"]);
	});

	it("getProvider synthesized from hasProvider; unknown provider -> undefined", () => {
		const reg = adaptOmpRegistry(makeOmpRegistry());
		expect(reg.getProvider("custom-api")).toEqual({ id: "custom-api" });
		expect(reg.getProvider("nope")).toBeUndefined();
		expect(reg.getRegisteredProviderConfig("nope")).toBeUndefined();
	});

	it("getApiKeyForProvider passes through to oh-my-pi", async () => {
		const reg = adaptOmpRegistry(makeOmpRegistry());
		await expect(reg.getApiKeyForProvider("custom-api")).resolves.toBe("tok-123");
	});
});
