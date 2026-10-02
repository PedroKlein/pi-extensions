import { getApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";

import { createPiGatewayTransport } from "../src/transport.js";

function makeFakeBackendProvider() {
  return {
    stream: vi.fn(() => ({ kind: "stream-result" })),
    streamSimple: vi.fn(() => ({ kind: "streamSimple-result" })),
  };
}

describe("gateway transport", () => {
  it("does not publish the gateway transport through the legacy global registry", () => {
    unregisterApiProviders("pi-gateway");
    createPiGatewayTransport();

    expect(getApiProvider("gateway" as never)).toBeUndefined();
  });

  it("delegates to the registered backend provider with the real model and request state", () => {
    const transport = createPiGatewayTransport();
    const provider = makeFakeBackendProvider();
    const realModel = {
      id: "anthropic--claude-4.8-opus",
      provider: "custom-backend",
      api: "custom-api",
      baseUrl: "https://real.example",
      contextWindow: 200_000,
      compat: { some: "capability" },
    };
    transport.setRoutes({
      "heavy-1": {
        backendName: "custom-backend",
        realApi: "custom-api",
        realModelId: realModel.id,
        realBaseUrl: realModel.baseUrl,
        realModel,
        realProvider: provider,
      },
    });

    const context = { messages: [] };
    const options = { apiKey: "real-backend-secret", headers: { "x-test": "1" } };
    const result = transport.stream(
      { id: "heavy-1", api: "gateway", baseUrl: realModel.baseUrl },
      context,
      options,
    );

    expect(result).toEqual({ kind: "stream-result" });
    expect(provider.stream).toHaveBeenCalledWith(realModel, context, options);
  });

  it("routes streamSimple to the registered backend provider", () => {
    const transport = createPiGatewayTransport();
    const provider = makeFakeBackendProvider();
    transport.setRoutes({
      "light-1": {
        backendName: "custom-backend",
        realApi: "custom-api",
        realModelId: "real-light",
        realBaseUrl: "https://real.example",
        realModel: {
          id: "real-light",
          provider: "custom-backend",
          api: "custom-api",
          baseUrl: "https://real.example",
        },
        realProvider: provider,
      },
    });

    const result = transport.streamSimple({ id: "light-1", api: "gateway" }, {}, {});

    expect(result).toEqual({ kind: "streamSimple-result" });
    expect(provider.streamSimple).toHaveBeenCalledTimes(1);
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it("throws a clear error when the alias has no route", () => {
    const transport = createPiGatewayTransport();
    transport.setRoutes({});

    expect(() => transport.stream({ id: "heavy-9", api: "gateway" }, {}, {})).toThrow(
      /no route for 'heavy-9'/,
    );
  });

  it("uses the backend's resolved authentication", () => {
    const transport = createPiGatewayTransport();
    const providerStream = vi.fn(() => ({ kind: "provider-result" }));
    transport.setRoutes({
      "heavy-1": {
        backendName: "custom-backend",
        realApi: "custom-api",
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

    const result = transport.stream(
      { id: "heavy-1", api: "gateway" },
      {},
      { apiKey: "gateway-secret", headers: { "x-gateway": "no" }, signal: "keep" },
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

  it("fails clearly when a route has no registered backend provider", () => {
    const transport = createPiGatewayTransport();
    transport.setRoutes({
      "heavy-1": {
        backendName: "missing-backend",
        realApi: "custom-api",
        realModelId: "x",
        realBaseUrl: "https://x",
        realModel: { id: "x", provider: "missing-backend" },
      },
    });

    expect(() => transport.stream({ id: "heavy-1", api: "gateway" }, {}, {})).toThrow(
      /registered provider dispatch is unavailable for 'missing-backend\/x'/,
    );
  });
});
