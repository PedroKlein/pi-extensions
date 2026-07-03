/**
 * Readonly bash validation engine.
 *
 * Uses a denylist approach: known-dangerous commands and mutating subcommands
 * are blocked. Everything else is allowed, with structural block rules (no
 * redirects, no heredocs, no command substitution, etc.) as the safety net.
 *
 * Rules data lives in bash-policy-rules.ts — this file contains only logic.
 */

import {
	BLOCK_RULES,
	DENIED_COMMANDS,
	SUBCOMMAND_POLICIES,
	DENIED_AWS_ACTIONS,
	DENIED_GCLOUD_ACTIONS,
	DANGEROUS_FIND_ARGS,
	YQ_INPLACE_FLAGS,
	MAKE_READONLY_FLAGS,
	TAR_READONLY_FLAGS,
	TAR_MUTATING_FLAGS,
	CURL_MUTATING_FLAGS,
	WGET_MUTATING_FLAGS,
} from "./bash-policy-rules.js";

export interface ReadonlyBashValidation {
	allowed: boolean;
	reason?: string;
}

export const READ_ONLY_BASH_ALLOWED_HINT =
	"Readonly bash blocks known-dangerous/mutating commands. Inspection commands are allowed.";

// ─── Redirect safety ───────────────────────────────────────────────────────

const ALL_REDIRECTS_PATTERN = /(^|\s)\d*>>?\s*\S/;
const INPUT_REDIRECT_PATTERN = /(^|\s)\d*<\s*\S/;

function hasUnsafeRedirects(command: string): { unsafe: boolean; reason?: string } {
	if (INPUT_REDIRECT_PATTERN.test(command)) {
		return { unsafe: true, reason: "input redirection is blocked" };
	}

	if (!ALL_REDIRECTS_PATTERN.test(command)) {
		return { unsafe: false };
	}

	const stripped = command
		.replace(/2>>?\/dev\/null/g, "")
		.replace(/2>&1/g, "")
		.replace(/>&2/g, "");

	if (ALL_REDIRECTS_PATTERN.test(stripped)) {
		return { unsafe: true, reason: "output redirection to file is blocked (2>/dev/null and 2>&1 are allowed)" };
	}

	return { unsafe: false };
}

// ─── find -exec validation ─────────────────────────────────────────────────

function validateFindExec(args: string[]): { allowed: boolean; reason?: string } {
	let i = 0;
	while (i < args.length) {
		const arg = args[i].toLowerCase();
		if (arg !== "-exec" && arg !== "-execdir") {
			i++;
			continue;
		}

		const execType = args[i];
		i++;

		if (i >= args.length) {
			return { allowed: false, reason: `${execType} with no command` };
		}

		const execCmd = normalizeCommand(args[i]);
		if (!execCmd) {
			return { allowed: false, reason: `${execType} with empty command` };
		}

		if (DENIED_COMMANDS.has(execCmd)) {
			return {
				allowed: false,
				reason: `find ${execType} runs '${execCmd}' which is a denied command`,
			};
		}

		i++;
		while (i < args.length && args[i] !== ";" && args[i] !== "+") {
			i++;
		}
		i++;
	}

	return { allowed: true };
}

// ─── Parsing helpers ───────────────────────────────────────────────────────

function normalizeCommand(token: string): string {
	const cleaned = token.trim();
	if (!cleaned) return "";
	const parts = cleaned.split("/");
	return parts[parts.length - 1].toLowerCase();
}

function splitTopLevel(command: string): { segments: string[]; error?: string } {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	const pushCurrent = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			escaped = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble) {
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				pushCurrent();
				i++;
				continue;
			}
			if (ch === ";" || ch === "|") {
				pushCurrent();
				continue;
			}
		}

		current += ch;
	}

	if (escaped) return { segments, error: "trailing escape (\\) is not allowed" };
	if (inSingle || inDouble) return { segments, error: "unclosed quote detected" };

	pushCurrent();
	return segments.length > 0 ? { segments } : { segments, error: "empty command" };
}

function tokenize(segment: string): { tokens: string[]; error?: string } {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			escaped = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (escaped) return { tokens, error: "trailing escape (\\) is not allowed" };
	if (inSingle || inDouble) return { tokens, error: "unclosed quote detected" };
	if (current) tokens.push(current);
	return { tokens };
}

// ─── Subcommand extraction ─────────────────────────────────────────────────

function getFirstSubcommand(args: string[]): string | null {
	for (const token of args) {
		if (!token) continue;
		if (token === "--") break;
		if (token.startsWith("-")) continue;
		return token.toLowerCase();
	}
	return null;
}

function getGitSubcommand(args: string[]): string | null {
	let i = 0;
	while (i < args.length) {
		const token = args[i];
		if (!token) { i++; continue; }
		if (token === "--") { i++; break; }

		if (token.startsWith("-")) {
			const takesValue =
				token === "-c" || token === "-C" ||
				token === "--git-dir" || token === "--work-tree" ||
				token === "--namespace" || token === "--exec-path" ||
				token === "--super-prefix" || token === "--config-env";

			const hasInlineValue =
				token.startsWith("--git-dir=") || token.startsWith("--work-tree=") ||
				token.startsWith("--namespace=") || token.startsWith("--exec-path=") ||
				token.startsWith("--super-prefix=") || token.startsWith("--config-env=");

			if (takesValue) { i += 2; continue; }
			if (hasInlineValue) { i++; continue; }
			i++;
			continue;
		}

		return token.toLowerCase();
	}
	return null;
}

// ─── Arg checks ────────────────────────────────────────────────────────────

function hasAnyArg(args: string[], values: Set<string>): boolean {
	for (const arg of args) {
		if (values.has(arg)) return true;
	}
	return false;
}

function hasAnyArgPrefix(args: string[], values: Set<string>): boolean {
	for (const arg of args) {
		const lower = arg.toLowerCase();
		for (const v of values) {
			if (lower === v || lower.startsWith(v)) return true;
		}
	}
	return false;
}

function hasSortOutputFlag(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "-o" || (arg.startsWith("-o") && arg.length > 2)) return true;
	}
	return false;
}

// ─── Git special cases ─────────────────────────────────────────────────────

function validateGitSpecialCases(sub: string, args: string[]): ReadonlyBashValidation {
	switch (sub) {
		case "branch": {
			const mutatingFlags = ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description"];
			for (const arg of args) {
				if (mutatingFlags.includes(arg)) {
					return { allowed: false, reason: "git branch with mutating flags is blocked" };
				}
			}
			const nonFlagArgs = args.filter(a => !a.startsWith("-") && a !== "--");
			const hasListFlag = args.some(a =>
				["-a", "-r", "-l", "--list", "--all", "--remotes", "-v", "-vv", "--verbose",
				 "--contains", "--no-contains", "--merged", "--no-merged",
				 "--color", "--no-color", "--column", "--no-column"].includes(a) ||
				a.startsWith("--sort") || a.startsWith("--format") || a.startsWith("--points-at"),
			);
			if (nonFlagArgs.length > 0 && !hasListFlag) {
				return { allowed: false, reason: "git branch with a name argument creates a branch — blocked" };
			}
			return { allowed: true };
		}

		case "remote": {
			const subArgs = args.filter(a => !a.startsWith("-"));
			if (subArgs.length === 0) return { allowed: true };
			const remoteSub = subArgs[0].toLowerCase();
			if (new Set(["show", "get-url"]).has(remoteSub)) return { allowed: true };
			return { allowed: false, reason: `git remote ${remoteSub} is blocked — may modify remotes` };
		}

		case "tag": {
			const hasListFlag = args.some(a =>
				["-l", "--list", "-n", "--contains", "--no-contains", "--merged", "--no-merged",
				 "-v", "--verify", "--column", "--no-column"].includes(a) ||
				a.startsWith("-n") || a.startsWith("--sort") || a.startsWith("--format") || a.startsWith("--points-at"),
			);
			const nonFlagArgs = args.filter(a => !a.startsWith("-") && a !== "--");
			if (nonFlagArgs.length > 0 && !hasListFlag) {
				return { allowed: false, reason: "git tag with a name argument creates a tag — blocked" };
			}
			return { allowed: true };
		}

		case "reflog": {
			const subArgs = args.filter(a => !a.startsWith("-"));
			if (subArgs.length === 0) return { allowed: true };
			if (subArgs[0].toLowerCase() === "show") return { allowed: true };
			return { allowed: false, reason: `git reflog ${subArgs[0]} is blocked — may modify reflog` };
		}

		case "hash-object": {
			if (args.includes("-w") || args.includes("--stdin")) {
				return { allowed: false, reason: "git hash-object -w writes to object store — blocked" };
			}
			return { allowed: true };
		}

		default:
			return { allowed: true };
	}
}

// ─── Special-case command validation ───────────────────────────────────────

function validateMake(args: string[]): ReadonlyBashValidation {
	// make is only allowed with readonly flags (-n, -p, -q, --version, --help)
	if (args.length === 0) {
		return { allowed: false, reason: "make without arguments executes build targets — blocked" };
	}
	const hasReadonlyFlag = args.some(a => MAKE_READONLY_FLAGS.has(a));
	if (!hasReadonlyFlag) {
		return { allowed: false, reason: "make without readonly flags (-n/--dry-run, -p, -q, --version, --help) is blocked" };
	}
	return { allowed: true };
}

function validateTar(args: string[]): ReadonlyBashValidation {
	// tar -t/--list is readonly; -x/-c/-r/-u are mutating
	if (hasAnyArg(args, TAR_MUTATING_FLAGS)) {
		return { allowed: false, reason: "tar extract/create/append is blocked — use -t/--list to inspect" };
	}
	if (hasAnyArg(args, TAR_READONLY_FLAGS)) {
		return { allowed: true };
	}
	// Check combined flags like -tvf
	for (const arg of args) {
		if (arg.startsWith("-") && !arg.startsWith("--")) {
			if (arg.includes("t")) return { allowed: true };
			if (arg.includes("x") || arg.includes("c") || arg.includes("r") || arg.includes("u")) {
				return { allowed: false, reason: "tar extract/create/append is blocked — use -t to inspect" };
			}
		}
	}
	return { allowed: false, reason: "tar without explicit -t/--list is blocked" };
}

function validateCurl(args: string[]): ReadonlyBashValidation {
	if (hasAnyArg(args, CURL_MUTATING_FLAGS)) {
		return { allowed: false, reason: "curl with data/upload/output flags is blocked — only GET requests allowed" };
	}
	return { allowed: true };
}

function validateWget(args: string[]): ReadonlyBashValidation {
	// wget almost always writes files — block unless just printing to stdout
	if (args.includes("-q") && args.includes("-O") && args.includes("-")) {
		return { allowed: true };  // wget -qO- URL prints to stdout
	}
	if (hasAnyArg(args, WGET_MUTATING_FLAGS)) {
		return { allowed: false, reason: "wget with output/mutation flags is blocked" };
	}
	// wget without -O- writes to a file by default
	const hasStdout = args.some((a, i, arr) =>
		(a === "-O" && arr[i + 1] === "-") || a === "-O-",
	);
	if (!hasStdout) {
		return { allowed: false, reason: "wget writes to file by default — use curl -s instead, or wget -O- to print to stdout" };
	}
	return { allowed: true };
}

function validateEnv(args: string[]): ReadonlyBashValidation {
	// `env` with no args or only flags → prints environment (readonly)
	// `env COMMAND args` → executes a command (dangerous)
	const nonEnvArgs: string[] = [];
	for (const arg of args) {
		// Skip env flags and VAR=VAL assignments
		if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
		nonEnvArgs.push(arg);
	}
	if (nonEnvArgs.length > 0) {
		return { allowed: false, reason: `env executes '${nonEnvArgs[0]}' — blocked in readonly mode` };
	}
	return { allowed: true };
}

// ─── Subcommand policy validation ──────────────────────────────────────────

function validateSubcommandPolicy(cmd: string, args: string[]): ReadonlyBashValidation {
	// AWS CLI: aws <service> <action>
	if (cmd === "aws") {
		const positional: string[] = [];
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			positional.push(arg.toLowerCase());
			if (positional.length >= 2) break;
		}
		if (positional.length < 2) return { allowed: true };
		const action = positional[1];
		for (const denied of DENIED_AWS_ACTIONS) {
			if (action.startsWith(denied)) {
				return { allowed: false, reason: `aws ${positional[0]} ${action} is a mutating action — blocked` };
			}
		}
		// Not denied → allowed
		return { allowed: true };
	}

	// gcloud
	if (cmd === "gcloud") {
		const positional: string[] = [];
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			positional.push(arg.toLowerCase());
		}
		for (const p of positional) {
			if (DENIED_GCLOUD_ACTIONS.has(p)) {
				return { allowed: false, reason: `gcloud action '${p}' is mutating — blocked` };
			}
		}
		// Not denied → allowed
		return { allowed: true };
	}

	// Standard subcommand policies
	const policy = SUBCOMMAND_POLICIES[cmd];
	if (!policy) return { allowed: true };

	// npx is always blocked
	if (cmd === "npx") {
		return { allowed: false, reason: "npx executes arbitrary code — blocked in readonly mode" };
	}

	const sub = cmd === "git" ? getGitSubcommand(args) : getFirstSubcommand(args);

	if (!sub) return { allowed: true };

	if (policy.denied.has(sub)) {
		return { allowed: false, reason: `${policy.label} ${sub} is a mutating subcommand — blocked` };
	}

	// Not denied — check git special cases, otherwise allow
	if (cmd === "git") {
		const gitResult = validateGitSpecialCases(sub, args);
		if (!gitResult.allowed) return gitResult;
	}

	return { allowed: true };
}

// ─── Main validator ────────────────────────────────────────────────────────

export function validateReadonlyBash(command: string): ReadonlyBashValidation {
	const trimmed = command.trim();
	if (!trimmed) return { allowed: false, reason: "empty command" };

	// Structural block rules
	for (const rule of BLOCK_RULES) {
		if (rule.pattern.test(trimmed)) {
			return { allowed: false, reason: rule.reason };
		}
	}

	// Redirect safety
	const redirectCheck = hasUnsafeRedirects(trimmed);
	if (redirectCheck.unsafe) {
		return { allowed: false, reason: redirectCheck.reason! };
	}

	// Parse pipeline/chain
	const split = splitTopLevel(trimmed);
	if (split.error) return { allowed: false, reason: split.error };

	for (const segment of split.segments) {
		const tokenized = tokenize(segment);
		if (tokenized.error) return { allowed: false, reason: tokenized.error };
		if (tokenized.tokens.length === 0) continue;

		// Skip env var assignments at the start
		let idx = 0;
		while (idx < tokenized.tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokenized.tokens[idx])) {
			idx++;
		}

		if (idx >= tokenized.tokens.length) {
			return { allowed: false, reason: "contains only environment assignments" };
		}

		const cmd = normalizeCommand(tokenized.tokens[idx]);
		const args = tokenized.tokens.slice(idx + 1);

		if (!cmd) {
			return { allowed: false, reason: "missing command" };
		}

		// Block shell wrappers with -c
		if (["bash", "sh", "zsh", "fish", "ksh", "dash"].includes(cmd) && args.includes("-c")) {
			return { allowed: false, reason: "shell wrapper with -c is blocked" };
		}

		// Any command with only --help or --version is always safe
		if (args.length > 0 && args.every(a => ["--help", "-h", "--version", "-V", "-v"].includes(a))) {
			continue;
		}

		// Check denied commands
		if (DENIED_COMMANDS.has(cmd)) {
			return { allowed: false, reason: `'${cmd}' is blocked in readonly mode` };
		}

		// Commands with subcommand policies
		if (SUBCOMMAND_POLICIES[cmd] || cmd === "aws" || cmd === "gcloud") {
			const subResult = validateSubcommandPolicy(cmd, args);
			if (!subResult.allowed) return subResult;
			continue;
		}

		// Special-case commands with mixed safety
		if (cmd === "make") {
			const r = validateMake(args);
			if (!r.allowed) return r;
			continue;
		}

		if (cmd === "tar") {
			const r = validateTar(args);
			if (!r.allowed) return r;
			continue;
		}

		if (cmd === "curl") {
			const r = validateCurl(args);
			if (!r.allowed) return r;
			continue;
		}

		if (cmd === "wget") {
			const r = validateWget(args);
			if (!r.allowed) return r;
			continue;
		}

		if (cmd === "env") {
			const r = validateEnv(args);
			if (!r.allowed) return r;
			continue;
		}

		// find: block dangerous args and validate -exec
		if (cmd === "find") {
			if (hasAnyArg(args, DANGEROUS_FIND_ARGS)) {
				return { allowed: false, reason: "find with -ok/-okdir/-delete is blocked" };
			}
			const execCheck = validateFindExec(args);
			if (!execCheck.allowed) return { allowed: false, reason: execCheck.reason! };
		}

		if (cmd === "yq" && hasAnyArg(args, YQ_INPLACE_FLAGS)) {
			return { allowed: false, reason: "yq in-place edit flags are blocked" };
		}

		if (cmd === "sort" && hasSortOutputFlag(args)) {
			return { allowed: false, reason: "sort -o writes files and is blocked" };
		}

		// Command not in denylist, not in subcommand policy → allowed.
		// The structural block rules (redirects, heredocs, eval, etc.) are the safety net.
	}

	return { allowed: true };
}
