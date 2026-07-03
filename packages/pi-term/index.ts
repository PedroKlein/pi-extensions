import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OverlayHandle, SelectItem } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import { loadConfig, type ResolvedApp } from "./config.js";
import { TerminalOverlay } from "./terminal-component.js";

interface ToggleState {
	overlay: TerminalOverlay;
	handle: OverlayHandle;
	hidden: boolean;
}

export default function (pi: ExtensionAPI) {
	let apps: ResolvedApp[] = [];
	const toggleStates = new Map<string, ToggleState>();
	let keysWidgetVisible = false;

	// Track registered shortcuts so we can note them (pi doesn't have unregisterShortcut)
	let registeredShortcuts: string[] = [];

	async function init(ctx: ExtensionContext) {
		const config = await loadConfig(ctx.cwd);
		apps = config.apps;

		// Register shortcuts for ALL apps (including conditional ones).
		// Conditions are checked lazily at launch time, not at startup,
		// to avoid slow subprocess spawns during init.
		for (const app of apps) {
			if (app.key) {
				pi.registerShortcut(app.key, {
					description: `pi-term: ${app.name}`,
					handler: async (ctx) => {
						await launchOrToggle(app, ctx);
					},
				});
				registeredShortcuts.push(app.key);
			}
		}
	}

	async function checkCondition(app: ResolvedApp): Promise<boolean> {
		if (!app.if) return true;
		try {
			const result = await pi.exec("sh", ["-c", app.if], { timeout: 3000 });
			return result.code === 0;
		} catch {
			return false;
		}
	}

	function parsePercent(value: string, total: number): number {
		if (value.endsWith("%")) {
			return Math.floor((parseInt(value) / 100) * total);
		}
		return parseInt(value) || total;
	}

	function calculateDimensions(
		app: ResolvedApp,
		termWidth: number,
		termHeight: number
	): { overlayWidth: number; innerCols: number; innerRows: number } {
		const overlayWidth = Math.max(parsePercent(app.width, termWidth), 10);
		const overlayHeight = Math.max(parsePercent(app.height, termHeight), 5);
		// Account for top border + bottom border = 2 lines
		const innerCols = Math.max(overlayWidth - 2, 1);
		const innerRows = Math.max(overlayHeight - 2, 1);
		return { overlayWidth, innerCols, innerRows };
	}

	async function launchOrToggle(app: ResolvedApp, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		// Check condition lazily at launch time (not at startup)
		const available = await checkCondition(app);
		if (!available) {
			ctx.ui.notify(`${app.name}: not available (${app.if})`, "warning");
			return;
		}

		// Toggle mode: check existing state
		if (app.toggle) {
			const state = toggleStates.get(app.name);
			if (state && !state.overlay.isExited()) {
				// Toggle visibility
				state.hidden = !state.hidden;
				state.handle.setHidden(state.hidden);
				return;
			}
			// Clean up dead toggle state
			if (state) {
				toggleStates.delete(app.name);
			}
		}

		await launchApp(app, ctx);
	}

	async function launchApp(app: ResolvedApp, ctx: ExtensionContext): Promise<void> {
		// Get terminal dimensions for calculating overlay size
		const termWidth = (ctx.ui as any).tui?.width ?? 120;
		const termHeight = (ctx.ui as any).tui?.height ?? 40;
		const { overlayWidth, innerCols, innerRows } = calculateDimensions(app, termWidth, termHeight);

		const exitCode = await ctx.ui.custom<number | null>(
			(tui, theme, _kb, done) => {
				const overlay = new TerminalOverlay({
					tui,
					theme,
					done,
					app: { ...app, cwd: app.cwd || ctx.cwd },
				});

				// Set initial PTY dimensions based on calculated overlay size
				overlay.resize(innerCols, innerRows);

				// Start the PTY process AFTER returning the component.
				// This ensures pi has fully set up the overlay before the
				// process starts emitting output.
				setTimeout(() => overlay.start(), 0);

				return {
					render: (w: number) => overlay.render(w),
					invalidate: () => overlay.invalidate(),
					handleInput: (data: string) => overlay.handleInput(data),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: app.anchor as any,
					width: app.width,
					maxHeight: app.height,
					minWidth: 20,
				},
			}
		);

		// Post-exit handling
		if (app.notify) {
			const level = exitCode === 0 ? "info" : "warning";
			ctx.ui.notify(`${app.name} exited (code ${exitCode ?? "?"})`, level as any);
		}

		if (app.feedContext) {
			try {
				const result = await pi.exec("sh", ["-c", app.feedContext], {
					timeout: 5000,
				});
				if (result.stdout?.trim()) {
					pi.sendMessage(
						{
							customType: "pi-term",
							content: `[pi-term] ${app.name} exited. Context:\n${result.stdout.trim()}`,
							display: true,
						},
						{ triggerTurn: false }
					);
				}
			} catch {
				// Ignore feed context errors
			}
		}

		// Clean up toggle state
		toggleStates.delete(app.name);
	}

	// /term command
	pi.registerCommand("term", {
		description: "Launch TUI apps in floating terminal overlays",
		getArgumentCompletions: (prefix: string) => {
			const items = apps
				.map((a) => ({
					value: a.name,
					label: a.name,
				}))
				.filter((i) => i.value.startsWith(prefix) || prefix === "");

			// Add special subcommands
			const specials = [
				{ value: "keys", label: "keys" },
			].filter((i) => i.value.startsWith(prefix) || prefix === "");

			return [...specials, ...items].length > 0 ? [...specials, ...items] : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("pi-term requires interactive mode", "error");
				return;
			}

			const trimmed = args?.trim() ?? "";

			// /term keys — toggle keybind widget
			if (trimmed === "keys") {
				toggleKeysWidget(ctx);
				return;
			}

			// /term -- <command> — run arbitrary command
			if (trimmed.startsWith("-- ")) {
				const cmd = trimmed.slice(3).trim();
				if (!cmd) {
					ctx.ui.notify("Usage: /term -- <command>", "warning");
					return;
				}
				const defaults = (await loadConfig(ctx.cwd)).defaults;
				const adhocApp: ResolvedApp = {
					name: cmd.split(/\s+/)[0] ?? cmd,
					cmd,
					width: defaults.width,
					height: defaults.height,
					anchor: defaults.anchor,
					closeKey: defaults.closeKey,
					shell: defaults.shell,
					toggle: false,
					holdOnExit: defaults.holdOnExit,
					notify: defaults.notify,
					borderColor: defaults.borderColor,
				};
				await launchApp(adhocApp, ctx);
				return;
			}

			// /term <name> — launch by name
			if (trimmed) {
				const app = apps.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
				if (!app) {
					ctx.ui.notify(`Unknown app: ${trimmed}`, "error");
					return;
				}
				await launchOrToggle(app, ctx);
				return;
			}

			// /term — show picker
			await showPicker(ctx);
		},
	});

	async function showPicker(ctx: ExtensionContext): Promise<void> {
		// Build items with keybind hints
		const items: SelectItem[] = [];
		for (const app of apps) {
			const available = await checkCondition(app);
			if (!available) continue;

			const keyHint = app.key ? `  ${app.key}` : "";
			items.push({
				value: app.name,
				label: `${app.name}${keyHint}`,
				description: `${app.cmd}${app.key ? ` (${app.key})` : ""}`,
			});
		}

		if (items.length === 0) {
			ctx.ui.notify("No apps configured. Create ~/.pi/agent/pi-term.json", "warning");
			return;
		}

		const choice = await ctx.ui.select("pi-term", items.map((i) => i.label));
		if (choice) {
			// Extract app name from the label (before the key hint)
			const appName = choice.split(/\s{2,}/)[0]?.trim();
			const app = apps.find((a) => a.name === appName);
			if (app) {
				await launchOrToggle(app, ctx);
			}
		}
	}

	function toggleKeysWidget(ctx: ExtensionContext): void {
		if (keysWidgetVisible) {
			ctx.ui.setWidget("pi-term-keys", undefined);
			keysWidgetVisible = false;
			return;
		}

		const appsWithKeys = apps.filter((a) => a.key);
		if (appsWithKeys.length === 0) {
			ctx.ui.notify("No keybindings configured", "warning");
			return;
		}

		ctx.ui.setWidget("pi-term-keys", (_tui, theme) => {
			const maxNameLen = Math.max(...appsWithKeys.map((a) => a.name.length));
			const maxKeyLen = Math.max(...appsWithKeys.map((a) => a.key!.length));

			// Two-column layout
			const colWidth = maxKeyLen + 1 + maxNameLen + 3;
			const pairs = appsWithKeys.map(
				(a) =>
					theme.fg("accent", a.key!.padEnd(maxKeyLen)) +
					" " +
					theme.fg("text", a.name.padEnd(maxNameLen))
			);

			const lines: string[] = [];
			const header = theme.fg("dim", "─── pi-term ───");
			lines.push(header);

			// Arrange in two columns
			for (let i = 0; i < pairs.length; i += 2) {
				const left = pairs[i];
				const right = i + 1 < pairs.length ? "   " + pairs[i + 1] : "";
				lines.push(" " + left + right);
			}

			return {
				render: () => lines,
				invalidate: () => {},
			};
		});
		keysWidgetVisible = true;
	}

	// Register message renderer for feedContext messages
	pi.registerMessageRenderer("pi-term", (message, _options, theme) => {
		const content = theme.fg("dim", message.content);
		return new Text(content, 1, 0);
	});

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		await init(ctx);
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async () => {
		// Kill all toggle-mode processes
		for (const [_name, state] of toggleStates) {
			state.overlay.kill();
		}
		toggleStates.clear();

		// Clear widget
		keysWidgetVisible = false;
	});
}
