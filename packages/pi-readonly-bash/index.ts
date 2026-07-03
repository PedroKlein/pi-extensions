/**
 * pi-readonly-bash — Provides a `bash_readonly` tool.
 *
 * Uses pi's createBashTool for identical execution behavior to the built-in
 * bash tool, wrapped with a validateReadonlyBash() gate that blocks mutating
 * commands before execution.
 *
 * When loaded as an extension, all bash_readonly calls are validated against
 * the readonly policy. Blocked commands return an error without executing.
 *
 * Relaxed policy: allows test/build/run commands (npm run, go test, cargo
 * build, etc.) while still blocking destructive mutations (rm, mv, sed,
 * redirects, heredocs, etc.).
 */

import { createBashTool } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { validateReadonlyBash, READ_ONLY_BASH_ALLOWED_HINT } from "./bash-policy.js";

export default function piReadonlyBash(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const baseTool = createBashTool(cwd);

	pi.registerTool({
		...baseTool,
		name: "bash_readonly",
		label: "bash (readonly)",
		description: [
			"Execute a bash command in the current working directory (readonly mode).",
			"Only inspection and non-destructive commands are allowed.",
			"Allowed: ls, cat, grep, find, git log/diff/status/branch, npm test/run/build, go test/build/run, cargo test/build/run, curl (GET), jq, wc, head, tail, sort, uniq, diff, file, stat, du, df, env, echo, printf, node -e, python -c.",
			"Blocked: rm, mv, cp, mkdir, chmod, sed, awk, redirects (>), heredocs (<<), tee, xargs, eval, install/publish/deploy commands.",
			"Output is truncated to last 2000 lines or 50KB. Use timeout for long-running commands.",
		].join(" "),

		renderCall(args: { command?: string; timeout?: number }, theme: any) {
			const command = typeof args.command === "string" && args.command.trim()
				? args.command
				: "...";
			const timeout = args.timeout
				? theme.fg("muted", ` (timeout ${args.timeout}s)`)
				: "";
			return new Text(`${theme.fg("accent", theme.bold("$"))} ${theme.fg("accent", command)}${timeout}`, 0, 0);
		},

		async execute(id, params, signal, onUpdate, ctx) {
			const command = typeof params.command === "string" ? params.command : "";
			const validation = validateReadonlyBash(command);

			if (!validation.allowed) {
				const reason = validation.reason ?? "readonly policy violation";
				return {
					content: [{
						type: "text" as const,
						text: `Readonly bash blocked: ${reason}. ${READ_ONLY_BASH_ALLOWED_HINT}`,
					}],
					isError: true,
				};
			}

			return baseTool.execute(id, params, signal, onUpdate);
		},
	});
}

export { validateReadonlyBash, READ_ONLY_BASH_ALLOWED_HINT } from "./bash-policy.js";
