/**
 * Caffeinate Extension
 *
 * Prevents the system from sleeping while pi is actively working.
 * Spawns a platform-native sleep inhibitor on agent_start, kills it on agent_end.
 *
 * - macOS:  caffeinate -i -w <pid>  (auto-exits if pi crashes)
 * - Linux:  systemd-inhibit --what=idle sleep infinity
 *
 * Each pi session manages its own inhibitor process.
 * The OS deduplicates multiple inhibit assertions naturally,
 * so concurrent sessions are fine with zero overhead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export default function (pi: ExtensionAPI) {
	let inhibitor: ChildProcess | null = null;

	function startInhibitor(ctx: ExtensionContext) {
		if (inhibitor) return;

		const os = platform();

		try {
			if (os === "darwin") {
				inhibitor = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
					stdio: "ignore",
				});
			} else if (os === "linux") {
				inhibitor = spawn(
					"systemd-inhibit",
					["--what=idle", "--who=pi", "--why=Pi agent active", "sleep", "infinity"],
					{ stdio: "ignore" },
				);
			} else {
				return;
			}

			inhibitor.on("error", () => {
				inhibitor = null;
				ctx.ui.setStatus("caffeinate", undefined);
				pi.events.emit("pi-status:update", { id: "caffeinate", render: null });
			});

			inhibitor.on("exit", () => {
				inhibitor = null;
				ctx.ui.setStatus("caffeinate", undefined);
				pi.events.emit("pi-status:update", { id: "caffeinate", render: null });
			});

			const theme = ctx.ui.theme;
			ctx.ui.setStatus("caffeinate", theme.fg("warning", "☕"));
			pi.events.emit("pi-status:register", {
				id: "caffeinate",
				priority: 5,
				render: (t: any) => t.fg("warning", "☕"),
			});
		} catch {
			inhibitor = null;
		}
	}

	function stopInhibitor(ctx: ExtensionContext) {
		if (!inhibitor) return;

		try {
			inhibitor.kill();
		} catch {
			// Already dead
		}
		inhibitor = null;
		ctx.ui.setStatus("caffeinate", undefined);
		pi.events.emit("pi-status:update", { id: "caffeinate", render: null });
	}

	pi.on("agent_start", async (_event, ctx) => {
		startInhibitor(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopInhibitor(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopInhibitor(ctx);
	});
}
