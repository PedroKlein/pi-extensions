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

import { createOmpGatewayTransport, ompRegisterProvider, toOmpModels } from "../src/omp-platform.js";

beforeEach(() => {
	calls.registerCustomApi.length = 0;
	calls.stream.length = 0;
	calls.streamSimple.length = 0;
});

const route = {
	"heavy-1": {
		realApi: "sap-ai-core",
		realModelId: "anthropic--claude-sonnet-4",
		realBaseUrl: "https://aicore.example/v2",
		realModel: {
			id: "anthropic--claude-sonnet-4",
			api: "sap-ai-core",
			baseUrl: "https://aicore.example/v2",
			contextWindow: 200000,
		},
	},
};

describe("createOmpGatewayTransport", () => {
	it("registers the gateway custom api once", () => {
		const t = createOmpGatewayTransport();
		t.register();
		t.register(); // idempotent
		expect(calls.registerCustomApi).toHaveLength(1);
		expect(calls.registerCustomApi[0].api).toBe("gateway");
		expect(calls.registerCustomApi[0].sourceId).toBe("pi-gateway");
	});

	it("delegates streamSimple with the REAL model id/api/baseUrl (not the alias)", () => {
		const t = createOmpGatewayTransport();
		t.register();
		t.setRoutes(route);
		const reg = calls.registerCustomApi[0];

		const out = reg.streamSimple({ id: "heavy-1", api: "gateway" }, { ctx: 1 }, { apiKey: "svc-key" });
		expect(out).toBe("STREAM_SIMPLE_RESULT");
		expect(calls.streamSimple).toHaveLength(1);
		const delivered = calls.streamSimple[0].model;
		expect(delivered.id).toBe("anthropic--claude-sonnet-4"); // wire name, not "heavy-1"
		expect(delivered.api).toBe("sap-ai-core");
		expect(delivered.baseUrl).toBe("https://aicore.example/v2");
		expect(calls.streamSimple[0].options).toEqual({ apiKey: "svc-key" });
	});

	it("delegates the full stream path too", () => {
		const t = createOmpGatewayTransport();
		t.register();
		t.setRoutes(route);
		const out = calls.registerCustomApi[0].stream({ id: "heavy-1", api: "gateway" }, {}, {});
		expect(out).toBe("STREAM_RESULT");
		expect(calls.stream[0].model.id).toBe("anthropic--claude-sonnet-4");
	});

	it("throws a clear error for a stale alias", () => {
		const t = createOmpGatewayTransport();
		t.register();
		t.setRoutes({}); // no routes
		expect(() => calls.registerCustomApi[0].streamSimple({ id: "ghost", api: "gateway" }, {}, {})).toThrow(
			/no route for 'ghost'/,
		);
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
	it("maps the neutral config onto oh-my-pi registerProvider (literal apiKey, provider baseUrl)", () => {
		const captured: Array<{ name: string; cfg: any }> = [];
		const reg = ompRegisterProvider({ registerProvider: (name, cfg) => captured.push({ name, cfg }) });
		reg("gateway", {
			models: [{ id: "heavy-1", name: "heavy-1", api: "gateway", baseUrl: "https://x", contextWindow: 1 }],
			apiKey: "$opaque!token", // must be passed literally, NOT escaped
			baseUrl: "https://aicore.example/v2",
		});
		expect(captured).toHaveLength(1);
		const { name, cfg } = captured[0];
		expect(name).toBe("gateway");
		expect(cfg.api).toBe("gateway");
		expect(cfg.baseUrl).toBe("https://aicore.example/v2");
		expect(cfg.apiKey).toBe("$opaque!token");
		expect(cfg.models[0].api).toBe("gateway");
		expect("baseUrl" in cfg.models[0]).toBe(false);
	});

	it("falls back to a valid placeholder baseUrl when none is provided", () => {
		const captured: Array<{ name: string; cfg: any }> = [];
		const reg = ompRegisterProvider({ registerProvider: (name, cfg) => captured.push({ name, cfg }) });
		reg("gateway", { models: [] });
		expect(() => new URL(captured[0].cfg.baseUrl)).not.toThrow();
	});
});
