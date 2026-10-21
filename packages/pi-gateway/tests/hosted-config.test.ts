import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function eventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data?: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

const aliases = {
	fallbackChain: ["primary", "fallback"],
	backends: {
		primary: { tiers: { medium: ["real-medium"] } },
		fallback: { tiers: { medium: ["fallback-medium"] } },
	},
};

const backendModels = [
	{
		id: "real-medium",
		name: "Primary Medium",
		provider: "primary",
		api: "openai-responses",
		baseUrl: "https://primary.example/v1",
	},
	{
		id: "fallback-medium",
		name: "Fallback Medium",
		provider: "fallback",
		api: "openai-responses",
		baseUrl: "https://fallback.example/v1",
	},
];

const registry = {
	find: (provider: string, id: string) =>
		backendModels.find((model) => model.provider === provider && model.id === id),
	getProvider: (name: string) =>
		backendModels.some((model) => model.provider === name) ? { id: name } : undefined,
	getRegisteredProviderConfig: (name: string) => {
		const model = backendModels.find((candidate) => candidate.provider === name);
		return model ? { api: model.api, baseUrl: model.baseUrl } : undefined;
	},
	getAll: () => backendModels,
	getApiKeyForProvider: async (name: string) => `resolved-${name}-token`,
};

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-gateway-hosted-"));
	dirs.push(dir);
	const statePath = join(dir, "gateway-state.json");
	vi.stubEnv("PI_GATEWAY_ALIASES_PATH", join(dir, "missing-aliases.json"));
	vi.stubEnv("PI_GATEWAY_STATE_PATH", statePath);

	const { activateGateway, CONFIG_EVENT, REQUEST_CONFIG_EVENT, STATE_EVENT } = await import(
		"../src/runtime.js"
	);
	const events = eventBus();
	const reported: any[] = [];
	events.on(REQUEST_CONFIG_EVENT, () => events.emit(CONFIG_EVENT, { aliases }));
	events.on(STATE_EVENT, (state) => reported.push(state));

	const handlers = new Map<string, (...args: any[]) => any>();
	const registerProvider = vi.fn();
	const host = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		events,
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	const platform = {
		transport: {
			setRoutes: vi.fn(),
			setFailureHandler: vi.fn(),
			stream: vi.fn(),
			streamSimple: vi.fn(),
		},
		registerProvider,
	};
	activateGateway(host as any, platform);

	const ctx = { modelRegistry: registry, ui: { notify: vi.fn() }, isIdle: () => true };
	return { activateGateway, CONFIG_EVENT, events, handlers, host, platform, registerProvider, reported, statePath, ctx };
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const lastModels = (registerProvider: ReturnType<typeof vi.fn>) =>
	registerProvider.mock.calls.at(-1)?.[1].models.map((model: { name: string }) => model.name);

describe("hosted config", () => {
	it("takes its aliases from a host extension instead of aliases.json", async () => {
		const { registerProvider } = await setup();

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerProvider.mock.calls[0][1].models.map((model: { id: string }) => model.id)).toEqual([
			"medium-1",
		]);
	});

	it("reports state changes to the host and keeps no state file", async () => {
		const { handlers, reported, statePath, ctx } = await setup();
		await handlers.get("session_start")?.({}, ctx);

		handlers.get("message_end")?.(
			{ message: { role: "assistant", stopReason: "error", errorStatus: 402 } },
			{ ...ctx, model: { provider: "gateway", id: "medium-1" } },
		);

		expect(reported).toHaveLength(1);
		expect(Object.keys(reported[0].unhealthyUntil)).toEqual(["primary"]);
		expect(existsSync(statePath)).toBe(false);
	});

	it("reroutes when the host sends new state", async () => {
		const { CONFIG_EVENT, events, handlers, registerProvider, ctx } = await setup();
		await handlers.get("session_start")?.({}, ctx);
		expect(lastModels(registerProvider)).toEqual(["Primary Medium (primary)"]);

		events.emit(CONFIG_EVENT, {
			aliases,
			state: {
				version: 1,
				unhealthyUntil: {
					primary: { until: new Date(Date.now() + 60_000).toISOString(), reason: "cap" },
				},
			},
		});
		await settle();

		expect(lastModels(registerProvider)).toEqual(["Fallback Medium (fallback)"]);
	});

	it("serves the provider from the first copy loaded into a session", async () => {
		const { activateGateway, host, registerProvider } = await setup();
		const second = vi.fn();

		activateGateway(host as any, { transport: {} as any, registerProvider: second });

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
	});
});
