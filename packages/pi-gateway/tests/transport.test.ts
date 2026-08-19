import { describe, expect, it, vi } from "vitest";

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";

import {
	_resetGatewayTransportForTests,
	gatewayRouteCount,
	registerGatewayTransport,
	setGatewayRoutes,
} from "../src/transport.js";

/**
 * These tests exercise the core fix: pi sends `model.id` verbatim as the wire
 * model name, so the gateway registers its own `gateway` api that maps the
 * neutral alias id to the real backend model and delegates to the real
 * transport with the REAL wire id/api/baseUrl.
 */

function makeFakeBackendApi(apiName: string) {
	const stream = vi.fn(() => ({ kind: "stream-result" }));
	const streamSimple = vi.fn(() => ({ kind: "streamSimple-result" }));
	registerApiProvider(
		{ api: apiName as never, stream: stream as never, streamSimple: streamSimple as never },
		"test-fake-backend",
	);
	return { stream, streamSimple };
}

describe("gateway transport", () => {
	it("delegates to the real backend api with the real wire model id/api/baseUrl", () => {
		_resetGatewayTransportForTests();
		const fake = makeFakeBackendApi("fake-backend-1");
		registerGatewayTransport();

		const realModel = {
			id: "anthropic--claude-4.8-opus",
			api: "fake-backend-1",
			baseUrl: "https://real.example",
			contextWindow: 200_000,
			compat: { some: "capability" },
		};
		setGatewayRoutes({
			"heavy-1": {
				realApi: "fake-backend-1",
				realModelId: "anthropic--claude-4.8-opus",
				realBaseUrl: "https://real.example",
				realModel,
			},
		});
		expect(gatewayRouteCount()).toBe(1);

		const gw = getApiProvider("fake-backend-1" as never) && getApiProvider("gateway" as never);
		expect(gw).toBeDefined();

		const ctx = { messages: [] };
		const options = { apiKey: "real-backend-secret", headers: { "x-test": "1" } };
		// pi passes the GATEWAY model (alias id) — the transport must swap it.
		const result = gw!.stream(
			{ id: "heavy-1", api: "gateway", baseUrl: "https://real.example" } as never,
			ctx as never,
			options as never,
		);

		expect(result).toEqual({ kind: "stream-result" });
		expect(fake.stream).toHaveBeenCalledTimes(1);
		const [passedModel, passedCtx, passedOptions] = fake.stream.mock.calls[0] as unknown as [
			Record<string, unknown>,
			unknown,
			unknown,
		];
		// The real wire model name is sent — NOT the alias "heavy-1".
		expect(passedModel.id).toBe("anthropic--claude-4.8-opus");
		expect(passedModel.api).toBe("fake-backend-1");
		expect(passedModel.baseUrl).toBe("https://real.example");
		// Capability fields from the real model are preserved.
		expect(passedModel.compat).toEqual({ some: "capability" });
		// Context and options (incl. the resolved backend credential) pass through.
		expect(passedCtx).toBe(ctx);
		expect(passedOptions).toBe(options);
	});

	it("routes streamSimple to the backend's streamSimple", () => {
		_resetGatewayTransportForTests();
		const fake = makeFakeBackendApi("fake-backend-2");
		registerGatewayTransport();
		setGatewayRoutes({
			"light-1": {
				realApi: "fake-backend-2",
				realModelId: "real-light",
				realBaseUrl: "https://real2.example",
				realModel: { id: "real-light", api: "fake-backend-2", baseUrl: "https://real2.example" },
			},
		});

		const gw = getApiProvider("gateway" as never)!;
		const result = gw.streamSimple({ id: "light-1", api: "gateway" } as never, {} as never, {} as never);
		expect(result).toEqual({ kind: "streamSimple-result" });
		expect(fake.streamSimple).toHaveBeenCalledTimes(1);
		expect(fake.stream).not.toHaveBeenCalled();
	});

	it("throws a clear error when the alias has no route (stale alias)", () => {
		_resetGatewayTransportForTests();
		registerGatewayTransport();
		setGatewayRoutes({}); // no routes

		const gw = getApiProvider("gateway" as never)!;
		expect(() => gw.stream({ id: "heavy-9", api: "gateway" } as never, {} as never, {} as never)).toThrow(
			/no route for 'heavy-9'/,
		);
	});

	it("dispatches through the real provider with its own resolved auth", () => {
		_resetGatewayTransportForTests();
		registerGatewayTransport();
		const providerStream = vi.fn(() => ({ kind: "provider-result" }));
		setGatewayRoutes({
			"heavy-1": {
				realApi: "never-registered-api",
				realModelId: "x",
				realBaseUrl: "https://x",
				realModel: { id: "x", provider: "custom-backend" },
				realProvider: { stream: providerStream, streamSimple: providerStream },
				realAuth: {
					auth: { apiKey: "backend-secret", headers: { "x-backend": "yes" } },
					env: { BACKEND_ENV: "1" },
				},
			},
		});

		const gw = getApiProvider("gateway" as never)!;
		const result = gw.stream(
			{ id: "heavy-1", api: "gateway" } as never,
			{} as never,
			{ apiKey: "gateway-secret", headers: { "x-gateway": "no" }, signal: "keep" } as never,
		);

		expect(result).toEqual({ kind: "provider-result" });
		expect(providerStream).toHaveBeenCalledWith(
			expect.objectContaining({ id: "x", provider: "custom-backend" }),
			{},
			{
				apiKey: "backend-secret",
				headers: { "x-backend": "yes", "x-gateway": "no" },
				env: { BACKEND_ENV: "1" },
				signal: "keep",
			},
		);
	});

	it("throws a clear error when neither the backend provider nor api is registered", () => {
		_resetGatewayTransportForTests();
		registerGatewayTransport();
		setGatewayRoutes({
			"heavy-1": {
				realApi: "never-registered-api",
				realModelId: "x",
				realBaseUrl: "https://x",
				realModel: { id: "x" },
			},
		});

		const gw = getApiProvider("gateway" as never)!;
		expect(() => gw.stream({ id: "heavy-1", api: "gateway" } as never, {} as never, {} as never)).toThrow(
			/not registered in pi's global api registry/,
		);
	});

	it("registerGatewayTransport is idempotent", () => {
		_resetGatewayTransportForTests();
		registerGatewayTransport();
		registerGatewayTransport(); // no throw, no double-register side effects
		expect(getApiProvider("gateway" as never)).toBeDefined();
	});
});
