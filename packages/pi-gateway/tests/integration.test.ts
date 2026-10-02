/**
 * End-to-end integration test.
 *
 * Simulates the full lifecycle:
 * - fake modelRegistry with two backends
 * - build controller
 * - initial register
 * - synthetic message_end with 402 on backend A
 * - verify neutral alias swaps to backend B on next register
 * - fast-forward past reset instant
 * - verify heal + re-register puts A back
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { GatewayController } from "../src/controller.js";
import type { RegistryLike } from "../src/session.js";
import { createPiGatewayTransport } from "../src/transport.js";
import { emptyState, readState, writeState } from "../src/state.js";

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
		getRegisteredProviderConfig: () => undefined,
		getAll: () => models.map((m) => ({ id: m.id, provider: m.provider })),
		getApiKeyForProvider: async (n) => `resolved-${n}`,
	};
}

async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function source(events: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

async function collect(stream: unknown): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream as AsyncIterable<any>) events.push(event);
	return events;
}

let dir: string;
let statePath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-gateway-integration-"));
	statePath = join(dir, "gateway-state.json");
	writeState(statePath, emptyState());
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("integration — full failover + heal cycle", () => {
	it("retries a pre-output 402 through the next registered provider in the same request", async () => {
		const transport = createPiGatewayTransport();
		const registry = fakeRegistry();
		const providerStream = vi.fn((model: { provider: string }) => {
			const failed = {
				role: "assistant",
				content: [],
				provider: model.provider,
				model: model.provider === "openrouter" ? "or-heavy" : "copilot-heavy",
				stopReason: "error",
				errorStatus: 402,
				errorMessage: "402: DAILY_CAP_EXCEEDED",
			};
			if (model.provider === "openrouter") {
				return source([
					{ type: "start", partial: failed },
					{ type: "error", reason: "error", error: failed },
				]);
			}
			const completed = {
				...failed,
				stopReason: "stop",
				errorStatus: undefined,
				errorMessage: undefined,
				usage: {
					input: 7,
					output: 3,
					cacheRead: 2,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
				},
			};
			return source([
				{ type: "start", partial: completed },
				{ type: "text_delta", contentIndex: 0, delta: "ok", partial: completed },
				{ type: "done", reason: "stop", message: completed },
			]);
		});
		registry.getProvider = (name) => ({ id: name, stream: providerStream, streamSimple: providerStream });
		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry,
			register: vi.fn(),
			notify: vi.fn(),
			setRoutes: (routes) => transport.setRoutes(routes),
			now: () => new Date("2025-01-15T12:00:00.000Z"),
		});
		transport.setFailureHandler((failure) => controller.handleTransportFailure(failure));
		await controller.initialize();

		const events = await collect(transport.streamSimple({ id: "heavy-1", api: "gateway" }, {}, {}));

		expect(providerStream.mock.calls.map(([model]) => model.provider)).toEqual([
			"openrouter",
			"github-copilot",
		]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
		expect(events.at(-1).message).toMatchObject({
			provider: "gateway",
			model: "heavy-1",
			usage: { input: 7, output: 3, totalTokens: 12, cost: { total: 0.031 } },
		});
		expect(readState(statePath).unhealthyUntil.openrouter).toBeDefined();
	});

	it("cap hit on openrouter → swap to github-copilot; reset expires → swap back", async () => {
		let now = new Date("2025-01-15T12:00:00.000Z");
		const microtasks: Array<() => void> = [];
		const register = vi.fn();
		const notify = vi.fn();

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => now,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		// Initial register.
		controller.requestReregister();
		expect(microtasks).toHaveLength(1);
		microtasks.shift()!();
		await drain();
		expect(register).toHaveBeenCalledTimes(1);
		let cfg = register.mock.calls[0][1];
		expect(cfg.apiKey).toBe("resolved-openrouter");

		// Trigger a 402 through heavy-1 (currently routed to openrouter).
		controller.handleMessageEnd({
			errorMessage:
				'402: {"error":{"cap_eur":"50.00","code":"DAILY_CAP_EXCEEDED","spent_eur":"50.27","type":"billing_error"}}',
			stopReason: "error",
			provider: "gateway",
			modelId: "heavy-1",
		});
		expect(microtasks).toHaveLength(1);
		microtasks.shift()!();
		await drain();
		expect(register).toHaveBeenCalledTimes(2);
		cfg = register.mock.calls[1][1];
		expect(cfg.apiKey).toBe("resolved-github-copilot");

		// State file records the transition, including quota enrichment.
		const persisted = readState(statePath);
		expect(persisted.unhealthyUntil["openrouter"]).toBeDefined();
		expect(persisted.unhealthyUntil["openrouter"].until).toBe("2025-01-16T00:00:00.000Z");
		expect(persisted.unhealthyUntil["openrouter"].quota).toEqual({
			spent: 50.27,
			cap: 50.0,
			currency: "EUR",
		});

		// Notify fired at least twice: one warning about openrouter unhealthy,
		// one info about the swap (fired by re-registration).
		const warnings = notify.mock.calls.filter((c) => String(c[0]).includes("openrouter"));
		expect(warnings.length).toBeGreaterThanOrEqual(1);

		// Advance clock past reset instant → sweep heals → re-register.
		now = new Date("2025-01-16T00:05:00.000Z");
		expect(controller.sweepExpiries()).toBe(true);
		expect(microtasks).toHaveLength(1);
		microtasks.shift()!();
		await drain();
		expect(register).toHaveBeenCalledTimes(3);
		cfg = register.mock.calls[2][1];
		// Back to openrouter since it's healthy again AND first in the chain.
		expect(cfg.apiKey).toBe("resolved-openrouter");
		expect(readState(statePath).unhealthyUntil).toEqual({});

		// A "healthy again" notify fired.
		const healed = notify.mock.calls.find(
			(c) => String(c[0]).includes("openrouter") && String(c[0]).includes("healthy"),
		);
		expect(healed).toBeDefined();
	});
});

describe("integration — both backends down", () => {
	it("all-down for a tier omits the neutral alias and fires a distinct error notify", async () => {
		const microtasks: Array<() => void> = [];
		const register = vi.fn();
		const notify = vi.fn();
		const NOW = new Date("2025-01-15T12:00:00.000Z");

		const controller = new GatewayController({
			aliases: CFG,
			statePath,
			registry: fakeRegistry(),
			register,
			notify,
			now: () => NOW,
			scheduleMicrotask: (fn) => microtasks.push(fn),
		});

		// Initial register to populate routing (heavy-1/light-1 → openrouter).
		controller.requestReregister();
		microtasks.shift()!();
		await drain();

		// First wave: cap heavy-1 and light-1 (route to openrouter) → openrouter unhealthy.
		// Re-compose routes both to github-copilot.
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
		microtasks.shift()!();
		await drain();

		// Second wave: cap heavy-1 and light-1 again (now routed to github-copilot)
		// → copilot unhealthy too. No healthy backend remains for either tier.
		register.mockClear();
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
		expect(microtasks).toHaveLength(1);
		microtasks.shift()!();
		await drain();

		const cfg = register.mock.calls[0][1];
		// Neither heavy-1 nor light-1 present — no healthy backend, no family-pinned
		// fallback anymore.
		expect(cfg.models.find((m: { id: string }) => m.id === "heavy-1")).toBeUndefined();
		expect(cfg.models.find((m: { id: string }) => m.id === "light-1")).toBeUndefined();
		expect(cfg.models).toHaveLength(0);

		// Distinct "no healthy backend" error notify.
		const allDownHeavy = notify.mock.calls.find(
			(c) =>
				c[1] === "error" &&
				String(c[0]).includes("no healthy backend") &&
				String(c[0]).includes("heavy"),
		);
		expect(allDownHeavy).toBeDefined();
	});
});
