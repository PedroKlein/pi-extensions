/**
 * GitHub PR URL parsing and API fetching.
 * Supports GitHub.com and GitHub Enterprise instances.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrMeta } from "./model.js";

/** Parsed PR URL components. */
export interface ParsedPrUrl {
	host: string;
	owner: string;
	repo: string;
	number: number;
	url: string;
}

/**
 * Parse a PR/MR URL into components.
 * Supports:
 *   https://github.com/owner/repo/pull/123
 *   https://github.example.com/owner/repo/pull/123
 *   https://gitlab.com/owner/repo/-/merge_requests/123
 */
export function parsePrUrl(url: string): ParsedPrUrl | null {
	// GitHub PR: /owner/repo/pull/number
	const ghMatch = url.match(
		/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/
	);
	if (ghMatch) {
		return {
			host: ghMatch[1],
			owner: ghMatch[2],
			repo: ghMatch[3],
			number: parseInt(ghMatch[4], 10),
			url,
		};
	}

	// GitLab MR: /owner/repo/-/merge_requests/number
	const glMatch = url.match(
		/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/
	);
	if (glMatch) {
		return {
			host: glMatch[1],
			owner: glMatch[2],
			repo: glMatch[3],
			number: parseInt(glMatch[4], 10),
			url,
		};
	}

	return null;
}

/**
 * Discover a GitHub token for the given host.
 * Tries: GH_TOKEN, GITHUB_TOKEN, then `gh auth token --hostname`.
 */
export async function discoverGitHubToken(
	host: string,
	pi: ExtensionAPI
): Promise<string | null> {
	// Environment variables
	const ghToken = process.env.GH_TOKEN;
	if (ghToken) return ghToken;

	const githubToken = process.env.GITHUB_TOKEN;
	if (githubToken) return githubToken;

	// gh CLI
	try {
		const result = await pi.exec("gh", ["auth", "token", "--hostname", host], {
			timeout: 5000,
		});
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// gh not installed or not authenticated
	}

	// Fallback: gh without hostname (default host)
	try {
		const result = await pi.exec("gh", ["auth", "token"], { timeout: 5000 });
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// Silently fail
	}

	return null;
}

/**
 * Fetch PR metadata from the GitHub API.
 * Uses /api/v3 prefix for GitHub Enterprise hosts.
 */
export async function fetchPrMeta(
	parsed: ParsedPrUrl,
	token: string | null
): Promise<PrMeta | null> {
	// Determine API base URL
	const isGitHubCom = parsed.host === "github.com";
	const apiBase = isGitHubCom
		? "https://api.github.com"
		: `https://${parsed.host}/api/v3`;

	const url = `${apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;

	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "pi-todo-extension",
	};
	if (token) {
		headers.Authorization = `token ${token}`;
	}

	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
		if (!response.ok) return null;

		const data = (await response.json()) as any;

		// Determine state (GitHub uses "open"/"closed" + "merged" flag)
		let state: "open" | "closed" | "merged" = "open";
		if (data.merged || data.merged_at) {
			state = "merged";
		} else if (data.state === "closed") {
			state = "closed";
		}

		return {
			title: data.title ?? `PR #${parsed.number}`,
			author: data.user?.login ?? "unknown",
			state,
			branch: data.head?.ref ?? "unknown",
			host: parsed.host,
			owner: parsed.owner,
			repo: parsed.repo,
			number: parsed.number,
		};
	} catch {
		return null;
	}
}

/**
 * Fetch PR diff using the gh CLI.
 * Requires gh CLI installed and authenticated.
 * For GitHub Enterprise, sets GH_HOST environment variable.
 */
export async function fetchPrDiff(
	parsed: ParsedPrUrl,
	pi: ExtensionAPI
): Promise<string | null> {
	try {
		const repoArg = `${parsed.owner}/${parsed.repo}`;
		const ghCmd = `gh pr diff ${parsed.number} --repo ${repoArg}`;
		// For GHE, gh CLI needs GH_HOST env var
		const cmd = parsed.host !== "github.com"
			? `GH_HOST=${parsed.host} ${ghCmd}`
			: ghCmd;
		const result = await pi.exec("bash", ["-c", cmd], { timeout: 30000 });
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout;
		}
	} catch {
		// gh not installed or failed
	}
	return null;
}

/**
 * Clone a PR branch to a temp directory.
 * Returns the clone path, or null on failure.
 */
export async function clonePrBranch(
	parsed: ParsedPrUrl,
	meta: PrMeta,
	pi: ExtensionAPI
): Promise<string | null> {
	const { join } = await import("node:path");
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");

	try {
		const tmpBase = join(tmpdir(), "pi-review-");
		const cloneDir = await mkdtemp(tmpBase);
		const repoUrl = `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`;

		const result = await pi.exec(
			"git",
			["clone", "--depth", "1", "--branch", meta.branch, repoUrl, cloneDir],
			{ timeout: 120000 }
		);

		if (result.code === 0) {
			return cloneDir;
		}

		// If branch clone fails, clone default and try to fetch the PR ref
		const fallback = await pi.exec(
			"git",
			["clone", "--depth", "1", repoUrl, cloneDir],
			{ timeout: 120000 }
		);
		if (fallback.code === 0) {
			await pi.exec(
				"git",
				["-C", cloneDir, "fetch", "origin", `pull/${parsed.number}/head:pr-${parsed.number}`],
				{ timeout: 60000 }
			);
			await pi.exec(
				"git",
				["-C", cloneDir, "checkout", `pr-${parsed.number}`],
				{ timeout: 10000 }
			);
			return cloneDir;
		}
	} catch {
		// Clone failed
	}
	return null;
}

/**
 * Build a fallback PrMeta from URL parsing alone (no API).
 */
export function fallbackPrMeta(parsed: ParsedPrUrl): PrMeta {
	return {
		title: `PR #${parsed.number}`,
		author: "unknown",
		state: "open",
		branch: "unknown",
		host: parsed.host,
		owner: parsed.owner,
		repo: parsed.repo,
		number: parsed.number,
	};
}
