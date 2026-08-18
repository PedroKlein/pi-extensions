import { describe, expect, it } from "vitest";

import { escapeConfigValue } from "../src/session.js";

/**
 * Mirror of pi's config-value template resolver (resolve-config-value.ts):
 * `$$`->`$`, `$!`->`!`, `${NAME}`/`$NAME` -> env lookup. We only need the
 * literal/env behavior to prove escapeConfigValue round-trips to the original
 * secret with an empty environment.
 */
function resolvePiConfigValue(config: string, env: Record<string, string> = {}): string {
	if (config.startsWith("!")) {
		throw new Error("would execute as a command");
	}
	let out = "";
	let i = 0;
	while (i < config.length) {
		const d = config.indexOf("$", i);
		if (d < 0) {
			out += config.slice(i);
			break;
		}
		out += config.slice(i, d);
		const next = config[d + 1];
		if (next === "$" || next === "!") {
			out += next;
			i = d + 2;
			continue;
		}
		if (next === "{") {
			const end = config.indexOf("}", d + 2);
			if (end < 0) {
				out += "$";
				i = d + 1;
				continue;
			}
			const name = config.slice(d + 2, end);
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				out += env[name] ?? process.env[name] ?? "";
			} else {
				out += config.slice(d, end + 1);
			}
			i = end + 1;
			continue;
		}
		const m = config.slice(d + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
		if (m) {
			out += env[m[0]] ?? process.env[m[0]] ?? "";
			i = d + 1 + m[0].length;
			continue;
		}
		out += "$";
		i = d + 1;
	}
	return out;
}

describe("escapeConfigValue", () => {
	const secrets = [
		"sk-opaque-bearer-token-1234",
		"ghp_$dollar$in$token",
		"${LOOKS_LIKE_ENV}",
		'{"clientid":"x","clientsecret":"a$b${c}d","url":"https://a"}', // BTP service-key JSON
		"!leading-bang-would-be-command",
		"$",
		"$$already",
		"plain",
	];

	for (const secret of secrets) {
		it(`round-trips through pi's resolver: ${secret.slice(0, 24)}`, () => {
			const escaped = escapeConfigValue(secret);
			// Never resolves as a shell command.
			expect(escaped.startsWith("!")).toBe(false);
			// Resolves back to the exact original secret with an empty environment.
			expect(resolvePiConfigValue(escaped)).toBe(secret);
		});
	}

	it("does not expand an env-var-looking token", () => {
		const escaped = escapeConfigValue("$HOME");
		// Would otherwise resolve to the HOME env var; escaped it stays literal.
		expect(resolvePiConfigValue(escaped, { HOME: "/should/not/leak" })).toBe("$HOME");
	});
});
