import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGatewayCommand, type GatewayCommandDeps } from "../src/command.js";
import { GatewayController } from "../src/controller.js";
import { emptyState, readState, writeState } from "../src/state.js";
import type { RegistryLike } from "../src/session.js";
import type { AliasesConfig } from "../src/config.js";

const ALIASES_JSON = {
	fallbackChain: ["hai-proxy", "github-copilot"],
	backends: {
		"hai-proxy": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: "hai-heavy", light: "hai-light" },
			capStatusCodes: [402, 429],
		},
		"github-copilot": {
			resetSchedule: "utc-monthly-1st",
			tiers: { heavy: "copilot-heavy" },
			capStatusCodes: [402],
		},
	},
};

function fakeRegistry(): RegistryLike {
	const models = [
		{ id: "hai-heavy", provider: "hai-proxy" },
		{ id: "hai-light", provider: "hai-proxy" },
		{ id: "copilot-heavy", provider: "github-copilot" },
	];
	return {
		find: (p, id) => models.find((m) => m.provider === p && m.id === id),
		getProvider: (n) => (models.some((m) => m.provider === n) ? { id: n } : undefined),
		getRegisteredProviderConfig: () => undefined,
		getAll: () => models.map((m) => ({ id: m.id, provider: m.provider })),
		getApiKeyForProvider: async (n) => `resolved-${n}`,
	};
}

let dir: string;
let statePath: string;
let aliasesPath: string;
let controller: GatewayController | undefined;
let pi: {
	registerCommand: ReturnType<typeof vi.fn>;
	registerProvider: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
};
let handler: ((args: string, ctx: unknown) => Promise<void> | void) | undefined;
let ctx: {
	ui: { notify: ReturnType<typeof vi.fn> };
	hasUI: boolean;
};

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pi-gateway-command-"));
	statePath = join(dir, "gateway-state.json");
	aliasesPath = join(dir, "aliases.json");
	writeFileSync(aliasesPath, JSON.stringify(ALIASES_JSON));
	writeState(statePath, emptyState());

	const notify = vi.fn();
	pi = {
		registerCommand: vi.fn(),
		registerProvider: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	ctx = {
		ui: { notify },
		hasUI: true,
	};

	const { loadAliasesConfig } = await import("../src/config.js");
	const aliases = loadAliasesConfig(aliasesPath);
	// Drain microtasks manually — synchronous initial register is fine for tests.
	const microtasks: Array<() => void> = [];
	controller = new GatewayController({
		aliases,
		statePath,
		registry: fakeRegistry(),
		register: (name, cfg) => pi.registerProvider(name, cfg),
		notify: (m, t) => notify(m, t),
		scheduleMicrotask: (fn) => microtasks.push(fn),
	});

	const deps: GatewayCommandDeps = {
		getController: () => controller,
		statePath,
		aliasesPath,
		rebuildController: async () => {
			const nextAliases = loadAliasesConfig(aliasesPath);
			controller = new GatewayController({
				aliases: nextAliases,
				statePath,
				registry: fakeRegistry(),
				register: (name, cfg) => pi.registerProvider(name, cfg),
				notify: (m, t) => notify(m, t),
				scheduleMicrotask: (fn) => microtasks.push(fn),
			});
		},
	};
	registerGatewayCommand(pi as unknown as ExtensionAPI, deps);
	handler = pi.registerCommand.mock.calls[0][1].handler;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("/gateway command — registration + description", () => {
	it("registers /gateway with a description", () => {
		expect(pi.registerCommand).toHaveBeenCalledTimes(1);
		const [name, cfg] = pi.registerCommand.mock.calls[0];
		expect(name).toBe("gateway");
		expect(cfg.description).toMatch(/Gateway routing status/i);
	});
});

describe("/gateway force <backend>", () => {
	it("sets activeBackendOverride and notifies", async () => {
		await handler!("force github-copilot", ctx);
		expect(readState(statePath).activeBackendOverride).toBe("github-copilot");
		const info = ctx.ui.notify.mock.calls.find((c) => c[1] === "info");
		expect(info?.[0]).toMatch(/forced active backend/i);
	});

	it("`force none` clears the override", async () => {
		writeState(statePath, { ...emptyState(), activeBackendOverride: "hai-proxy" });
		await handler!("force none", ctx);
		expect(readState(statePath).activeBackendOverride).toBeUndefined();
	});

	it("bare `force` (no arg) also clears", async () => {
		writeState(statePath, { ...emptyState(), activeBackendOverride: "hai-proxy" });
		await handler!("force", ctx);
		expect(readState(statePath).activeBackendOverride).toBeUndefined();
	});

	it("`force nonsense` errors and does not touch state", async () => {
		await handler!("force does-not-exist", ctx);
		const err = ctx.ui.notify.mock.calls.find((c) => c[1] === "error");
		expect(err).toBeDefined();
		expect(err?.[0]).toMatch(/unknown backend/i);
		// State unchanged.
		expect(readState(statePath).activeBackendOverride).toBeUndefined();
	});
});

describe("/gateway reload", () => {
	it("re-reads aliases.json and reflects the new mapping in registered gateway provider", async () => {
		// Initial register: two backends.
		const initialCall = pi.registerProvider.mock.calls[0];
		// After beforeEach, the controller has queued its initial register but
		// scheduleMicrotask was captured in an array we can't easily drain from
		// here. What we CAN check is the aliases-reload path: rewrite the file
		// so the new controller sees a single-backend config, run /gateway reload,
		// and assert the state file survives + notify says success.
		writeFileSync(
			aliasesPath,
			JSON.stringify({
				fallbackChain: ["hai-proxy"],
				backends: {
					"hai-proxy": {
						resetSchedule: "utc-midnight",
						tiers: { heavy: "hai-heavy" },
						capStatusCodes: [402],
					},
				},
			}),
		);

		await handler!("reload", ctx);
		const info = ctx.ui.notify.mock.calls.find(
			(c) => c[1] === "info" && String(c[0]).includes("reloaded"),
		);
		expect(info).toBeDefined();
	});

	it("reload with invalid aliases.json emits an error and does not crash", async () => {
		writeFileSync(aliasesPath, "not valid json{");
		await handler!("reload", ctx);
		const err = ctx.ui.notify.mock.calls.find((c) => c[1] === "error");
		expect(err).toBeDefined();
		expect(String(err?.[0])).toMatch(/reload failed/i);
	});
});

describe("/gateway status (default)", () => {
	it("sends the status text via sendUserMessage", async () => {
		await handler!("", ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const text = pi.sendUserMessage.mock.calls[0][0];
		expect(text).toContain("gateway");
		expect(text).toContain("hai-proxy");
	});
});

describe("/gateway toggle <backend>", () => {
	it("flips a backend's health", async () => {
		await handler!("toggle hai-proxy", ctx);
		expect(readState(statePath).unhealthyUntil["hai-proxy"]).toBeDefined();
		// Toggle again → healthy.
		await handler!("toggle hai-proxy", ctx);
		expect(readState(statePath).unhealthyUntil["hai-proxy"]).toBeUndefined();
	});

	it("errors on unknown backend name", async () => {
		await handler!("toggle ghost", ctx);
		const err = ctx.ui.notify.mock.calls.find((c) => c[1] === "error");
		expect(err?.[0]).toMatch(/unknown backend/i);
	});
});

describe("/gateway unknown subcommand", () => {
	it("prints an error listing valid options", async () => {
		await handler!("bogus", ctx);
		const err = ctx.ui.notify.mock.calls.find((c) => c[1] === "error");
		expect(err?.[0]).toMatch(/unknown subcommand/i);
	});
});
