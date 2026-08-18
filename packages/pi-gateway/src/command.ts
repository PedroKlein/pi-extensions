/**
 * /gateway command wiring.
 *
 * v1 exposes /gateway as a subcommand-driven interface rather than a full
 * interactive Component TUI. Subcommands:
 *
 *   /gateway              -> interactive board (falls back to status text w/o UI)
 *   /gateway status       -> alias for the bare form
 *   /gateway models       -> alias/model/provider mapping (modal, or text w/o UI)
 *   /gateway force <name> -> set activeBackendOverride
 *   /gateway force none   -> clear activeBackendOverride
 *   /gateway clear        -> clear all overrides
 *   /gateway toggle <name>-> flip a backend's health for its normal reset window
 *   /gateway reload       -> reload aliases.json + state.json from disk
 *
 * When an interactive TUI is available the bare/status/models forms open a
 * `ctx.ui.custom()` overlay whose keys are wired to the same mutation actions
 * as the text subcommands. Without a UI (print/RPC) they emit text via
 * `sendUserMessage` so the transcript still records the snapshot.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GatewayHostApi } from "./host.js";

import {
	requestReload,
	setActiveOverride,
	toggleBackendHealth,
} from "./actions.js";
import { AliasesConfigError, loadAliasesConfig } from "./config.js";
import type { GatewayController } from "./controller.js";
import { showGatewayModal, type GatewayModalDeps } from "./interactive.js";
import { nextResetInstant } from "./reset-schedule.js";
import { renderModelsText, renderStatusText } from "./status-view.js";
import { readState, updateState, type GatewayState } from "./state.js";

export interface GatewayCommandDeps {
	getController: () => GatewayController | undefined;
	statePath: string;
	aliasesPath: string;
	/** Rebuild the controller after reload; called by the reload subcommand. */
	rebuildController: () => Promise<void>;
	/** Real model ids registered for a backend (provider), sorted + stable. */
	listModels: (backend: string) => string[];
	/** All provider names known to the registry, sorted. */
	listProviders: () => string[];
}

export function registerGatewayCommand(pi: GatewayHostApi, deps: GatewayCommandDeps): void {
	const modalDeps: GatewayModalDeps = {
		getController: deps.getController,
		statePath: deps.statePath,
		aliasesPath: deps.aliasesPath,
		rebuildController: deps.rebuildController,
		listModels: deps.listModels,
		listProviders: deps.listProviders,
	};
	pi.registerCommand("gateway", {
		description:
			"Gateway routing status & controls. Usage: /gateway [status|models|force <backend>|force none|clear|toggle <backend>|reload]",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ value: "status", label: "status — interactive board" },
				{ value: "models", label: "models — alias/model/provider map" },
				{ value: "force", label: "force <backend> — pin routing" },
				{ value: "clear", label: "clear — drop all overrides" },
				{ value: "toggle", label: "toggle <backend> — flip health" },
				{ value: "reload", label: "reload — re-read config" },
			];
			const filtered = subs.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const controller = deps.getController();
			if (!controller) {
				ctx.ui.notify(
					"gateway: extension not active (missing aliases.json?). Run /gateway reload after creating it.",
					"warning",
				);
				return;
			}

			const trimmed = (args ?? "").trim();
			const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const restJoined = rest.join(" ");

			switch (sub) {
				case undefined:
				case "":
				case "status":
					if (canOpenModal(ctx)) {
						await showGatewayModal(ctx, modalDeps, { startMode: "main" });
					} else {
						printStatus(pi, controller, deps);
					}
					return;

				case "models":
					if (canOpenModal(ctx)) {
						await showGatewayModal(ctx, modalDeps, { startMode: "models" });
					} else {
						printModels(pi, deps);
					}
					return;

				case "force":
					await handleForce(controller, deps, restJoined, ctx);
					return;

				case "clear":
					handleClear(controller, deps, ctx);
					return;

				case "toggle":
					handleToggle(controller, deps, restJoined, ctx);
					return;

				case "reload":
					await handleReload(deps, ctx);
					return;

				default:
					ctx.ui.notify(
						`gateway: unknown subcommand '${sub}'. Try: /gateway [status|models|force <backend>|clear|toggle <backend>|reload]`,
						"error",
					);
			}
		},
	});
}

/** Whether an interactive overlay can be shown (guards print/RPC + test ctx). */
function canOpenModal(ctx: ExtensionCommandContext): boolean {
	return ctx.hasUI && typeof ctx.ui.custom === "function";
}

function printStatus(
	pi: GatewayHostApi,
	controller: GatewayController,
	_deps: GatewayCommandDeps,
): void {
	// We can't easily read aliases from the controller (it's private); grab a
	// fresh copy from disk. Falling back silently if the file has moved.
	const state = controller.getState();
	let aliases;
	try {
		aliases = loadAliasesConfig(_deps.aliasesPath);
	} catch {
		pi.sendUserMessage("gateway: could not read aliases.json for status view", {
			deliverAs: "followUp",
		});
		return;
	}
	const text = renderStatusText({ aliases, state });
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function printModels(pi: GatewayHostApi, deps: GatewayCommandDeps): void {
	const controller = deps.getController();
	if (!controller) return;
	let aliases;
	try {
		aliases = loadAliasesConfig(deps.aliasesPath);
	} catch {
		pi.sendUserMessage("gateway: could not read aliases.json for models view", {
			deliverAs: "followUp",
		});
		return;
	}
	const text = renderModelsText({ aliases, state: controller.getState() });
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

async function handleForce(
	controller: GatewayController,
	deps: GatewayCommandDeps,
	arg: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const target = arg === "" ? undefined : arg;
	const cleared = target === undefined || target === "none";
	const nextOverride = cleared ? undefined : target;
	let aliases;
	try {
		aliases = loadAliasesConfig(deps.aliasesPath);
	} catch (err) {
		ctx.ui.notify(`gateway: ${(err as Error).message}`, "error");
		return;
	}
	if (nextOverride && !(nextOverride in aliases.backends)) {
		ctx.ui.notify(
			`gateway: unknown backend '${nextOverride}'. Known: ${Object.keys(aliases.backends).join(", ")}`,
			"error",
		);
		return;
	}
	updateState(deps.statePath, (cur) => {
		const result = setActiveOverride(cur, aliases, nextOverride);
		return result.kind === "state-updated" ? result.nextState : cur;
	});
	// Reload controller's state cache and re-register.
	controller.reloadStateFromDisk();
	ctx.ui.notify(
		nextOverride
			? `gateway: forced active backend to '${nextOverride}'`
			: "gateway: cleared active-backend override",
		"info",
	);
}

function handleClear(
	controller: GatewayController,
	deps: GatewayCommandDeps,
	ctx: ExtensionCommandContext,
): void {
	updateState(deps.statePath, (cur) => ({
		...cur,
		activeBackendOverride: undefined,
		fallbackChainOverride: undefined,
	}));
	controller.reloadStateFromDisk();
	ctx.ui.notify("gateway: cleared all overrides", "info");
}

function handleToggle(
	controller: GatewayController,
	deps: GatewayCommandDeps,
	arg: string,
	ctx: ExtensionCommandContext,
): void {
	if (!arg) {
		ctx.ui.notify("gateway: usage: /gateway toggle <backend>", "error");
		return;
	}
	let aliases;
	try {
		aliases = loadAliasesConfig(deps.aliasesPath);
	} catch (err) {
		ctx.ui.notify(`gateway: ${(err as Error).message}`, "error");
		return;
	}
	if (!(arg in aliases.backends)) {
		ctx.ui.notify(`gateway: unknown backend '${arg}'`, "error");
		return;
	}
	const backend = aliases.backends[arg];
	const until = nextResetInstant(backend.resetSchedule, new Date());
	updateState(deps.statePath, (cur) => {
		const r = toggleBackendHealth(cur, aliases, arg, until);
		return r.kind === "state-updated" ? r.nextState : cur;
	});
	controller.reloadStateFromDisk();
	ctx.ui.notify(`gateway: toggled '${arg}' health`, "info");
}

async function handleReload(
	deps: GatewayCommandDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		// Force aliases reload by rebuilding the controller.
		await deps.rebuildController();
		ctx.ui.notify("gateway: reloaded aliases.json + state.json", "info");
	} catch (err) {
		if (err instanceof AliasesConfigError) {
			ctx.ui.notify(`gateway reload failed: ${err.message}`, "error");
			return;
		}
		ctx.ui.notify(`gateway reload failed: ${(err as Error).message}`, "error");
	}
}
