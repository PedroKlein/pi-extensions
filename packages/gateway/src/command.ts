/**
 * /gateway command wiring.
 *
 * v1 exposes /gateway as a subcommand-driven interface rather than a full
 * interactive Component TUI. Subcommands:
 *
 *   /gateway              -> print status text
 *   /gateway status       -> alias for the bare form
 *   /gateway force <name> -> set activeBackendOverride
 *   /gateway force none   -> clear activeBackendOverride
 *   /gateway clear        -> clear all overrides
 *   /gateway toggle <name>-> flip a backend's health for its normal reset window
 *   /gateway reload       -> reload aliases.json + state.json from disk
 *
 * The command is deliberately text-oriented — the status view is emitted via
 * `sendUserMessage` as a followup so the transcript records the snapshot;
 * mutating subcommands print a one-line confirmation and trigger controller
 * re-registration.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	requestReload,
	setActiveOverride,
	toggleBackendHealth,
} from "./actions.js";
import { AliasesConfigError, loadAliasesConfig } from "./config.js";
import type { GatewayController } from "./controller.js";
import { nextResetInstant } from "./reset-schedule.js";
import { renderStatusText } from "./status-view.js";
import { readState, updateState, type GatewayState } from "./state.js";

export interface GatewayCommandDeps {
	getController: () => GatewayController | undefined;
	statePath: string;
	aliasesPath: string;
	/** Rebuild the controller after reload; called by the reload subcommand. */
	rebuildController: () => Promise<void>;
}

export function registerGatewayCommand(pi: ExtensionAPI, deps: GatewayCommandDeps): void {
	pi.registerCommand("gateway", {
		description:
			"Gateway routing status & controls. Usage: /gateway [status|force <backend>|force none|clear|toggle <backend>|reload]",
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
					printStatus(pi, controller, deps);
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
						`gateway: unknown subcommand '${sub}'. Try: /gateway [status|force <backend>|clear|toggle <backend>|reload]`,
						"error",
					);
			}
		},
	});
}

function printStatus(
	pi: ExtensionAPI,
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
