import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HANDOFFS_DIR = join(homedir(), ".pi", "handoffs");

/**
 * Resolve a repo slug from a git remote URL or cwd.
 * Examples:
 *   git@github.com:PedroKlein/wafer-poc.git → PedroKlein-wafer-poc
 *   https://github.com/PedroKlein/pi-extensions → PedroKlein-pi-extensions
 *   (no remote) → basename of git root or cwd
 */
export function resolveRepoSlug(remoteUrl: string | null, fallbackPath: string): string {
	if (remoteUrl) {
		// Strip .git suffix
		const cleaned = remoteUrl.replace(/\.git$/, "");
		// SSH format: git@host:owner/repo
		const sshMatch = cleaned.match(/[^@]+@[^:]+:(.+)/);
		if (sshMatch) {
			return sshMatch[1].replace(/\//g, "-");
		}
		// HTTPS format: https://host/owner/repo
		const httpsMatch = cleaned.match(/https?:\/\/[^/]+\/(.+)/);
		if (httpsMatch) {
			return httpsMatch[1].replace(/\//g, "-");
		}
	}
	// Fallback: use the last directory name
	return fallbackPath.split("/").filter(Boolean).pop() || "unknown";
}

/**
 * Get the handoff directory for a repo slug.
 */
export function getHandoffDir(repoSlug: string): string {
	return join(HANDOFFS_DIR, repoSlug);
}

/**
 * Get the path to latest.md for a repo slug.
 */
export function getLatestPath(repoSlug: string): string {
	return join(getHandoffDir(repoSlug), "latest.md");
}

/**
 * Get the archive path for a handoff.
 */
export function getArchivePath(repoSlug: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(getHandoffDir(repoSlug), "archive", `${timestamp}.md`);
}

/**
 * Write a handoff file, creating directories as needed.
 */
export function writeHandoff(repoSlug: string, content: string): string {
	const path = getLatestPath(repoSlug);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
	return path;
}

/**
 * Read and archive a handoff file. Returns content or null if not found.
 */
export function consumeHandoff(repoSlug: string): { content: string; path: string } | null {
	const latestPath = getLatestPath(repoSlug);
	if (!existsSync(latestPath)) return null;

	const content = readFileSync(latestPath, "utf-8");

	// Archive it
	const archivePath = getArchivePath(repoSlug);
	mkdirSync(dirname(archivePath), { recursive: true });
	renameSync(latestPath, archivePath);

	return { content, path: archivePath };
}

/**
 * Check if a handoff exists for a repo slug.
 */
export function hasHandoff(repoSlug: string): boolean {
	return existsSync(getLatestPath(repoSlug));
}

/**
 * Build the pickup message that gets copied to clipboard.
 */
export function buildPickupMessage(repoSlug: string): string {
	return `/pickup`;
}
