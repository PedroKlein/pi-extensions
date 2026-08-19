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
		const registerProvider = vi.fn();
		activate({
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerCommand: vi.fn(),
			registerProvider,
			sendUserMessage: vi.fn(),
		} as any);

		// No session_start handler has run. The provider must already be queued so
		// --model gateway/... and configured defaults can resolve during startup.
		expect(handlers.has("session_start")).toBe(true);
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
				fallbackChain: ["backend"],
				backends: { backend: { tiers: { medium: ["real-medium"] } } },
			}),
		);
		vi.stubEnv("PI_GATEWAY_ALIASES_PATH", aliasesPath);
		vi.stubEnv("PI_GATEWAY_STATE_PATH", statePath);

		const { activateGateway } = await import("../src/runtime.js");
		const handlers = new Map<string, (...args: any[]) => any>();
		const backendModel = {
			id: "real-medium",
			provider: "backend",
			api: "openai-responses",
			baseUrl: "https://backend.example/v1",
			reasoning: true,
			contextWindow: 272_000,
			maxTokens: 32_000,
		};
		let gatewayModels: any[] = [];
		const registry = {
			find: (provider: string, id: string) =>
				provider === "backend"
					? (id === backendModel.id ? backendModel : undefined)
					: gatewayModels.find((model) => model.id === id),
			getProvider: (name: string) => (name === "backend" ? { id: name } : undefined),
			getRegisteredProviderConfig: (name: string) =>
				name === "backend"
					? { api: "openai-responses", baseUrl: "https://backend.example/v1" }
					: undefined,
			getAll: () => [backendModel, ...gatewayModels],
			getApiKeyForProvider: async (name: string) =>
				name === "backend" ? "resolved-backend-token" : undefined,
		};
		const registerProvider = vi.fn((name: string, config: { models: any[] }) => {
			if (name === "gateway") {
				gatewayModels = config.models.map((model) => ({ ...model, provider: "gateway" }));
			}
		});
		const setModel = vi.fn(async () => true);
		const host = {
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerCommand: vi.fn(),
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
			contextWindow: 272_000,
			maxTokens: 32_000,
		});
		await handlers.get("session_shutdown")?.({}, {});
	});
});
