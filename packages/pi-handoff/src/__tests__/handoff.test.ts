import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	resolveRepoSlug,
	getHandoffDir,
	getLatestPath,
	getArchivePath,
	writeHandoff,
	consumeHandoff,
	hasHandoff,
} from "../handoff.js";

describe("resolveRepoSlug", () => {
	it("parses SSH remote URL", () => {
		expect(resolveRepoSlug("git@github.com:PedroKlein/wafer-poc.git", "/tmp"))
			.toBe("PedroKlein-wafer-poc");
	});

	it("parses HTTPS remote URL", () => {
		expect(resolveRepoSlug("https://github.com/PedroKlein/pi-extensions", "/tmp"))
			.toBe("PedroKlein-pi-extensions");
	});

	it("strips .git suffix from HTTPS", () => {
		expect(resolveRepoSlug("https://github.com/org/repo.git", "/tmp"))
			.toBe("org-repo");
	});

	it("handles GitHub Enterprise SSH", () => {
		expect(resolveRepoSlug("git@github.concur.com:strat/kms-lite.git", "/tmp"))
			.toBe("strat-kms-lite");
	});

	it("handles GitHub Enterprise HTTPS", () => {
		expect(resolveRepoSlug("https://github.concur.com/strat/kms-lite", "/tmp"))
			.toBe("strat-kms-lite");
	});

	it("falls back to directory basename when no remote", () => {
		expect(resolveRepoSlug(null, "/Users/me/Dev/github.com/org/my-project"))
			.toBe("my-project");
	});

	it("falls back to 'unknown' for empty path", () => {
		expect(resolveRepoSlug(null, ""))
			.toBe("unknown");
	});
});

describe("path helpers", () => {
	it("getHandoffDir returns correct path", () => {
		const dir = getHandoffDir("PedroKlein-wafer-poc");
		expect(dir).toContain(".pi/handoffs/PedroKlein-wafer-poc");
	});

	it("getLatestPath ends with latest.md", () => {
		const path = getLatestPath("org-repo");
		expect(path).toMatch(/\.pi\/handoffs\/org-repo\/latest\.md$/);
	});

	it("getArchivePath includes timestamp and lives under archive/", () => {
		const path = getArchivePath("org-repo");
		expect(path).toMatch(/\.pi\/handoffs\/org-repo\/archive\/\d{4}-\d{2}-\d{2}T.*\.md$/);
	});
});

describe("writeHandoff / consumeHandoff / hasHandoff", () => {
	const testSlug = `test-handoff-${Date.now()}`;

	afterEach(() => {
		// Cleanup
		const dir = getHandoffDir(testSlug);
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true });
		}
	});

	it("writeHandoff creates the file", () => {
		const content = "# Test handoff\n\nGoal: test";
		const path = writeHandoff(testSlug, content);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	it("hasHandoff returns true when file exists", () => {
		writeHandoff(testSlug, "content");
		expect(hasHandoff(testSlug)).toBe(true);
	});

	it("hasHandoff returns false when no file", () => {
		expect(hasHandoff(testSlug)).toBe(false);
	});

	it("consumeHandoff reads and archives", () => {
		const content = "# Handoff content";
		writeHandoff(testSlug, content);

		const result = consumeHandoff(testSlug);
		expect(result).not.toBeNull();
		expect(result!.content).toBe(content);

		// latest.md should be gone
		expect(existsSync(getLatestPath(testSlug))).toBe(false);

		// archive file should exist
		expect(existsSync(result!.path)).toBe(true);
		expect(readFileSync(result!.path, "utf-8")).toBe(content);
	});

	it("consumeHandoff returns null when no file", () => {
		expect(consumeHandoff(testSlug)).toBeNull();
	});
});
