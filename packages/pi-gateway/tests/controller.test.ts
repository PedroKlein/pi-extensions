import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { GatewayController } from "../src/controller.js";
import { writeState, emptyState, readState } from "../src/state.js";
import type { RegistryLike } from "../src/session.js";

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setImmediate(r));
	}
}

const CFG: AliasesConfig = {
	fallbackChain: ["openrouter", "github-copilot"],
	backends: {
		"openrouter": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: ["or-heavy"], light: ["or-light"] },
			quotaHint: "daily-eur-cap",
			capStatusCodes: [402, 429],
		},
		"github-copilot": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: ["copilot-heavy"], light: ["copilot-light"] },
			quotaHint: undefined,
			capStatusCodes: [402],
		},
	},
};

function fakeRegistry(): RegistryLike {
	const models = [
		{ id: "or-heavy", provider: "openrouter", baseUrl: "https://openrouter.example", api: "openai-completions" },
		{ id: "or-light", provider: "openrouter", baseUrl: "https://openrouter.example", api: "openai-completions" },
		{ id: "copilot-heavy", provider: "github-copilot", baseUrl: "https://copilot.example", api: "openai-completions" },
		{ id: "copilot-light", provider: "github-copilot", baseUrl: "https://copilot.example", api: "openai-completions" },
	];
	return {
		find: (p, id) => models.find((m) => m.provider === p && m.id === id),
		getProvider: (n) => (models.some((m) => m.provider === n) ? { id: n } : undefined),
		getRegisteredProviderConfig: (n) =>
			n === "openrouter"
				? { apiKey: "!echo or-tok", baseUrl: "https://openrouter.example", api: "openai-completions" }
				: undefined,
		getAll: () => models.map((m) => ({ id: m.id, provider: m.provider })),
		getApiKeyForProvider: async (n) => `resolved-${n}`,
	};
}

let dir: string;
let statePath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-gateway-controller-"));
	statePath = join(dir, "gateway-state.json");
	writeState(statePath, emptyState());
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("GatewayController — debounce", () => {
	it("three simultaneous transitions cause exactly one re-registration call", async () => {
		const register = vi.fn();
		const notify = vi.fn();
		const NOW = new Date("2025-01-15T12:00:00.000Z");
		const microtasks: Array<() => void> = [];

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => NOW,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		// Populate the routing map via the initial registration (as session_start
		// does), then drain so `heavy-1`/`light-1` attribute correctly.
		controller.requestReregister();
		expect(microtasks).toHaveLength(1);
		microtasks.shift()!();
		await drainMicrotasks();
		register.mockClear();

		// Simulate three transitions in quick succession (all route to openrouter).
		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "light-1",
		});
		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});

		// Drain the microtask queue.
		expect(microtasks).toHaveLength(1); // debounced!
		microtasks[0]();
		await drainMicrotasks();

		expect(register).toHaveBeenCalledTimes(1);
	});
});

describe("GatewayController — re-registration reflects transitions", () => {
	it("marks a transport failure unhealthy and rebuilds the route before retrying", async () => {
		const register = vi.fn();
		const routes: Array<Record<string, { backendName?: string }>> = [];
		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify: vi.fn(),
			setRoutes: (next) => routes.push(next),
			now: () => new Date("2025-01-15T12:00:00.000Z"),
		});
		await controller.initialize();
		expect(routes.at(-1)?.["heavy-1"].backendName).toBe("openrouter");

		const retry = await controller.handleTransportFailure({
			aliasId: "heavy-1",
			backendName: "openrouter",
			errorStatus: 503,
			errorMessage: "service unavailable",
		});

		expect(retry).toBe(true);
		expect(readState(statePath).unhealthyUntil.openrouter).toBeDefined();
		expect(routes.at(-1)?.["heavy-1"].backendName).toBe("github-copilot");
	});

	it("refreshes the active gateway model after every successful registration", async () => {
		const register = vi.fn();
		const onRegistered = vi.fn();
		const microtasks: Array<() => void> = [];
		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify: vi.fn(),
			onRegistered,
			now: () => new Date("2025-01-15T12:00:00.000Z"),
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		await controller.initialize();
		expect(onRegistered).toHaveBeenCalledTimes(1);

		controller.reloadStateFromDisk();
		microtasks.shift()!();
		await drainMicrotasks();
		expect(onRegistered).toHaveBeenCalledTimes(2);
	});

	it("after cap hit, subsequent registered models exclude the unhealthy backend for neutral aliases", async () => {
		const register = vi.fn();
		const notify = vi.fn();
		const NOW = new Date("2025-01-15T12:00:00.000Z");
		const microtasks: Array<() => void> = [];

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => NOW,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		// Initial registration to populate routing (heavy-1 → openrouter).
		controller.requestReregister();
		microtasks.shift()!();
		await drainMicrotasks();
		register.mockClear();

		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		microtasks[0]();
		await drainMicrotasks();

		const [_name, cfg] = register.mock.calls[0];
		// heavy-1 should now route to github-copilot since openrouter is unhealthy;
		// auth is provider-level, so the effective backend's token is the apiKey.
		expect(cfg.apiKey).toBe("resolved-github-copilot");
	});
});

describe("GatewayController — notify shape", () => {
	it("notify message contains backend name and reset ETA", async () => {
		const register = vi.fn();
		const notify = vi.fn();
		const NOW = new Date("2025-01-15T12:00:00.000Z");
		const microtasks: Array<() => void> = [];

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => NOW,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		controller.requestReregister();
		microtasks.shift()!();
		await drainMicrotasks();

		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		microtasks[0]();
		await drainMicrotasks();

		const warnings = notify.mock.calls.filter((c) => String(c[0]).includes("openrouter"));
		expect(warnings.length).toBeGreaterThan(0);
		// Expect: backend name + something time-shaped
		expect(warnings[0][0]).toMatch(/openrouter.*(resets|in \d)/);
	});
});

describe("GatewayController — all-down case", () => {
	it("when every backend for a tier is unhealthy, emits distinct 'no healthy backend' notify", async () => {
		const register = vi.fn();
		const notify = vi.fn();
		const NOW = new Date("2025-01-15T12:00:00.000Z");
		const microtasks: Array<() => void> = [];

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => NOW,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		// Initial registration: heavy-1 → openrouter.
		controller.requestReregister();
		microtasks.shift()!();
		await drainMicrotasks();

		// First cap takes out openrouter; re-compose routes heavy-1 → github-copilot.
		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		microtasks.shift()!();
		await drainMicrotasks();

		// Second cap on heavy-1 now attributes to github-copilot, taking out the
		// last healthy backend for the tier.
		register.mockClear();
		controller.handleMessageEnd({
			errorMessage: "402: {}",
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		microtasks[0]();
		await drainMicrotasks();

		// heavy-1 alias should be missing from registered models.
		const [_n, cfg] = register.mock.calls[0];
		expect(cfg.models.find((m: { id: string }) => m.id === "heavy-1")).toBeUndefined();

		// A distinct all-down notify fired.
		const allDown = notify.mock.calls.find(
			(c) =>
				String(c[0]).includes("no healthy backend") &&
				String(c[0]).includes("heavy"),
		);
		expect(allDown).toBeDefined();
		expect(allDown?.[1]).toBe("error");
	});
});

describe("GatewayController — sweepExpiries", () => {
	it("removes expired entries and re-registers", async () => {
		writeState(statePath, {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": {
					until: new Date("2025-01-15T10:00:00.000Z").toISOString(),
					reason: "old",
				},
			},
		});
		const register = vi.fn();
		const notify = vi.fn();
		const microtasks: Array<() => void> = [];
		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => new Date("2025-01-15T12:00:00.000Z"), // 2h after until
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});
		const healed = controller.sweepExpiries();
		expect(healed).toBe(true);
		expect(readState(statePath).unhealthyUntil).toEqual({});

		microtasks[0]?.();
		await drainMicrotasks();

		// A "healthy again" notify fires.
		expect(notify.mock.calls.some((c) => String(c[0]).includes("healthy"))).toBe(true);
	});
});
