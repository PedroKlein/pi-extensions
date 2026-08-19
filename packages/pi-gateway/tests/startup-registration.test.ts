import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startup registration", () => {
	it("makes configured gateway aliases selectable before session_start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-gateway-startup-"));
		dirs.push(dir);
		const aliasesPath = join(dir, "aliases.json");
		writeFileSync(
			aliasesPath,
			JSON.stringify({
				fallbackChain: ["primary", "fallback"],
				backends: {
					primary: {
						tiers: {
							heavy: ["opus", "gpt-frontier"],
							medium: ["sonnet", "gpt-medium", "gemini"],
							light: ["haiku", "gpt-mini"],
						},
					},
					fallback: {
						tiers: {
							heavy: ["sol", "opus"],
							medium: ["terra", "sonnet", "gemini"],
							light: ["luna", "haiku"],
						},
					},
				},
			}),
		);
		vi.stubEnv("PI_GATEWAY_ALIASES_PATH", aliasesPath);

		const { default: activate } = await import("../src/index.js");
		const handlers = new Map<string, (...args: any[]) => any>();
		const registerCommand = vi.fn();
		const registerProvider = vi.fn();
		activate({
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerCommand,
			registerProvider,
			sendUserMessage: vi.fn(),
		} as any);

		// No session_start handler has run. Providers and commands must both be
		// registered during extension load because OMP snapshots registrations
		// before it emits session_start.
		expect(handlers.has("session_start")).toBe(true);
		expect(registerCommand).toHaveBeenCalledTimes(1);
		expect(registerCommand.mock.calls[0][0]).toBe("gateway");
		expect(registerProvider).toHaveBeenCalledTimes(1);
		const [name, config] = registerProvider.mock.calls[0];
		expect(name).toBe("gateway");
		expect(config.apiKey).toBe("gateway-bootstrap");
		expect(typeof config.streamSimple).toBe("function");
		expect(config.models.every((model: { baseUrl?: string }) => model.baseUrl === "https://pi-gateway.invalid")).toBe(true);
		expect(config.models.map((model: { id: string }) => model.id)).toEqual([
			"heavy-1",
			"heavy-2",
			"medium-1",
			"medium-2",
			"medium-3",
			"light-1",
			"light-2",
		]);
	});

	it("replaces the selected bootstrap alias with resolved metadata before session_start completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-gateway-startup-"));
		dirs.push(dir);
		const aliasesPath = join(dir, "aliases.json");
		const statePath = join(dir, "gateway-state.json");
		writeFileSync(
			aliasesPath,
			JSON.stringify({
				fallbackChain: ["primary", "fallback"],
				backends: {
					primary: { tiers: { medium: ["real-medium"] } },
					fallback: { tiers: { medium: ["fallback-medium"] } },
				},
			}),
		);
		vi.stubEnv("PI_GATEWAY_ALIASES_PATH", aliasesPath);
		vi.stubEnv("PI_GATEWAY_STATE_PATH", statePath);

		const { activateGateway } = await import("../src/runtime.js");
		const handlers = new Map<string, (...args: any[]) => any>();
		const backendModels = [
			{
				id: "real-medium",
				name: "Primary Medium",
				provider: "primary",
				api: "openai-responses",
				baseUrl: "https://primary.example/v1",
				reasoning: true,
				contextWindow: 272_000,
				maxTokens: 32_000,
			},
			{
				id: "fallback-medium",
				name: "Fallback Medium",
				provider: "fallback",
				api: "openai-responses",
				baseUrl: "https://fallback.example/v1",
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
		];
		let gatewayModels: any[] = [];
		const registry = {
			find: (provider: string, id: string) =>
				provider === "gateway"
					? gatewayModels.find((model) => model.id === id)
					: backendModels.find((model) => model.provider === provider && model.id === id),
			getProvider: (name: string) =>
				backendModels.some((model) => model.provider === name) ? { id: name } : undefined,
			getRegisteredProviderConfig: (name: string) => {
				const model = backendModels.find((candidate) => candidate.provider === name);
				return model ? { api: model.api, baseUrl: model.baseUrl } : undefined;
			},
			getAll: () => [...backendModels, ...gatewayModels],
			getApiKeyForProvider: async (name: string) =>
				backendModels.some((model) => model.provider === name) ? `resolved-${name}-token` : undefined,
		};
		const registerProvider = vi.fn((name: string, config: { models: any[] }) => {
			if (name === "gateway") {
				gatewayModels = config.models.map((model) => ({ ...model, provider: "gateway" }));
			}
		});
		const setModel = vi.fn(async () => true);
		const registerCommand = vi.fn();
		const host = {
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerCommand,
			sendUserMessage: vi.fn(),
			setModel,
		};
		activateGateway(host as any, {
			transport: { register: vi.fn(), setRoutes: vi.fn(), stream: vi.fn(), streamSimple: vi.fn() },
			registerProvider,
		});
		expect(registerProvider).toHaveBeenCalledTimes(1); // bootstrap

		await handlers.get("session_start")?.(
			{},
			{
				modelRegistry: registry,
				model: { provider: "gateway", id: "medium-1" },
				ui: { notify: vi.fn() },
				isIdle: () => true,
			},
		);

		expect(registerProvider).toHaveBeenCalledTimes(2);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0][0]).toMatchObject({
			provider: "gateway",
			id: "medium-1",
			name: "Primary Medium (primary)",
			contextWindow: 272_000,
			maxTokens: 32_000,
		});

		const command = registerCommand.mock.calls[0][1].handler;
		await command("force fallback", { hasUI: false, ui: { notify: vi.fn() } });
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
		expect(setModel).toHaveBeenCalledTimes(2);
		expect(setModel.mock.calls[1][0]).toMatchObject({
			provider: "gateway",
			id: "medium-1",
			name: "Fallback Medium (fallback)",
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
		await handlers.get("session_shutdown")?.({}, {});
	});
});
