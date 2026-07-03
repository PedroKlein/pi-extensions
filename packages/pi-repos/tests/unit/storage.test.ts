import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureStorageDirs,
  loadIndex,
  saveIndex,
  resolveRepo,
  repoId,
  repoMetaDir,
  groupDir,
  appendAnnotation,
  readAnnotations,
  readSummary,
  writeTldr,
  addReference,
  removeReference,
  type RepoIndex,
} from "../../src/storage.js";
import type { RepoEntry, ReposConfig } from "../../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

function makeConfig(dir: string): ReposConfig {
  return { storageDir: dir };
}

function makeEntry(host: string, owner: string, name: string): RepoEntry {
  return {
    host,
    owner,
    name,
    type: "local",
    url: null,
    path: `/fake/${host}/${owner}/${name}`,
    defaultBranch: "main",
    worktrees: [],
    tags: [],
    autoTags: [],
    starred: false,
    lastAccessed: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    lastSyncedAt: null,
    commitsBehind: null,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `pi-repos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── ensureStorageDirs ────────────────────────────────────────────────────────

describe("ensureStorageDirs", () => {
  it("creates base, repos, and groups directories", () => {
    const config = makeConfig(testDir);
    ensureStorageDirs(config);
    expect(existsSync(testDir)).toBe(true);
    expect(existsSync(join(testDir, "repos"))).toBe(true);
    expect(existsSync(join(testDir, "groups"))).toBe(true);
  });

  it("is idempotent — safe to call multiple times", () => {
    const config = makeConfig(testDir);
    ensureStorageDirs(config);
    expect(() => ensureStorageDirs(config)).not.toThrow();
  });
});

// ─── loadIndex / saveIndex ───────────────────────────────────────────────────

describe("loadIndex", () => {
  it("returns empty index when no file exists", () => {
    const config = makeConfig(testDir);
    const index = loadIndex(config);
    expect(index).toEqual({ repos: [] });
  });

  it("returns empty index on corrupt JSON", () => {
    const config = makeConfig(testDir);
    ensureStorageDirs(config);
    writeFileSync(join(testDir, "index.json"), "not valid json", "utf-8");
    const index = loadIndex(config);
    expect(index).toEqual({ repos: [] });
  });
});

describe("saveIndex / loadIndex roundtrip", () => {
  it("persists and restores a repo entry", () => {
    const config = makeConfig(testDir);
    ensureStorageDirs(config);
    const entry = makeEntry("github.com", "acme", "myrepo");
    const index: RepoIndex = { repos: [entry] };

    saveIndex(config, index);
    const loaded = loadIndex(config);

    expect(loaded.repos).toHaveLength(1);
    expect(loaded.repos[0].host).toBe("github.com");
    expect(loaded.repos[0].owner).toBe("acme");
    expect(loaded.repos[0].name).toBe("myrepo");
  });

  it("persists multiple entries", () => {
    const config = makeConfig(testDir);
    ensureStorageDirs(config);
    const entries = [
      makeEntry("github.com", "org", "alpha"),
      makeEntry("github.com", "org", "beta"),
      makeEntry("gitlab.com", "org", "gamma"),
    ];
    saveIndex(config, { repos: entries });

    const loaded = loadIndex(config);
    expect(loaded.repos).toHaveLength(3);
    expect(loaded.repos.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ─── resolveRepo ─────────────────────────────────────────────────────────────

describe("resolveRepo", () => {
  it("resolves by full host/owner/name", () => {
    const entry = makeEntry("github.com", "acme", "widget");
    const index: RepoIndex = { repos: [entry] };
    const found = resolveRepo(index, "github.com/acme/widget");
    expect(found.name).toBe("widget");
  });

  it("resolves by owner/name when unambiguous", () => {
    const entry = makeEntry("github.com", "acme", "widget");
    const index: RepoIndex = { repos: [entry] };
    const found = resolveRepo(index, "acme/widget");
    expect(found.name).toBe("widget");
  });

  it("throws when not found", () => {
    const index: RepoIndex = { repos: [] };
    expect(() => resolveRepo(index, "acme/missing")).toThrow("not found");
  });

  it("throws on ambiguous owner/name across multiple hosts", () => {
    const index: RepoIndex = {
      repos: [
        makeEntry("github.com", "acme", "widget"),
        makeEntry("gitlab.com", "acme", "widget"),
      ],
    };
    expect(() => resolveRepo(index, "acme/widget")).toThrow("Ambiguous");
  });

  it("throws on invalid identifier format", () => {
    const index: RepoIndex = { repos: [] };
    expect(() => resolveRepo(index, "justname")).toThrow("Invalid repo identifier");
  });
});

// ─── repoId ──────────────────────────────────────────────────────────────────

describe("repoId", () => {
  it("returns host/owner/name string", () => {
    const entry = makeEntry("github.com", "pedro", "myrepo");
    expect(repoId(entry)).toBe("github.com/pedro/myrepo");
  });
});

// ─── repoMetaDir / groupDir ──────────────────────────────────────────────────

describe("path helpers", () => {
  it("repoMetaDir builds correct path inside repos/", () => {
    const config = makeConfig("/storage");
    const entry = makeEntry("github.com", "acme", "widget");
    const metaDir = repoMetaDir(config, entry);
    expect(metaDir).toBe("/storage/repos/github.com/acme/widget/.meta");
  });

  it("groupDir builds correct path inside groups/", () => {
    const config = makeConfig("/storage");
    const dir = groupDir(config, "my-group");
    expect(dir).toBe("/storage/groups/my-group");
  });
});

// ─── appendAnnotation / readAnnotations ──────────────────────────────────────

describe("annotations", () => {
  it("appends and reads back an annotation", () => {
    const notesPath = join(testDir, "notes.md");
    appendAnnotation(notesPath, {
      category: "architecture",
      content: "Uses layered architecture with adapters.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const annotations = readAnnotations(notesPath);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].category).toBe("architecture");
    expect(annotations[0].content).toContain("layered architecture");
  });

  it("appends multiple annotations", () => {
    const notesPath = join(testDir, "notes.md");
    appendAnnotation(notesPath, {
      category: "bug",
      content: "Known race condition on shutdown.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    appendAnnotation(notesPath, {
      category: "pattern",
      content: "Uses repository pattern for storage.",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const annotations = readAnnotations(notesPath);
    expect(annotations).toHaveLength(2);
    expect(annotations[0].category).toBe("bug");
    expect(annotations[1].category).toBe("pattern");
  });

  it("returns empty array when file does not exist", () => {
    const notesPath = join(testDir, "missing.md");
    const annotations = readAnnotations(notesPath);
    expect(annotations).toEqual([]);
  });

  it("stores and reads files array", () => {
    const notesPath = join(testDir, "notes.md");
    appendAnnotation(notesPath, {
      category: "decision",
      content: "Use JSON for storage.",
      timestamp: "2026-01-01T00:00:00.000Z",
      files: ["src/storage.ts", "src/types.ts"],
    });

    const annotations = readAnnotations(notesPath);
    expect(annotations[0].files).toEqual(["src/storage.ts", "src/types.ts"]);
  });
});

// ─── writeTldr / readSummary ──────────────────────────────────────────────────

describe("summary", () => {
  it("returns null when no summary exists", () => {
    const metaDir = join(testDir, ".meta");
    const result = readSummary(metaDir);
    expect(result).toBeNull();
  });

  it("writes and reads back a TL;DR", () => {
    const metaDir = join(testDir, ".meta");
    writeTldr(metaDir, "Fast HTTP client for Node.js.\nSupports HTTP/2.", "abc123");

    const summary = readSummary(metaDir);
    expect(summary).not.toBeNull();
    expect(summary!.tldr).toContain("Fast HTTP client");
    expect(summary!.rev).toBe("abc123");
    expect(summary!.stale).toBe(false);
  });
});

// ─── addReference / removeReference ──────────────────────────────────────────

describe("references", () => {
  it("adds a reference to an entry", () => {
    const entry = makeEntry("github.com", "acme", "app");
    const refEntry = makeEntry("github.com", "acme", "lib");
    const index: RepoIndex = { repos: [entry, refEntry] };

    addReference(index, entry, { repo: "github.com/acme/lib", reason: "shared types" });

    expect(entry.references).toHaveLength(1);
    expect(entry.references![0].repo).toBe("github.com/acme/lib");
    expect(entry.references![0].reason).toBe("shared types");
  });

  it("is idempotent — adding same ref updates existing", () => {
    const entry = makeEntry("github.com", "acme", "app");
    const refEntry = makeEntry("github.com", "acme", "lib");
    const index: RepoIndex = { repos: [entry, refEntry] };

    addReference(index, entry, { repo: "github.com/acme/lib" });
    addReference(index, entry, { repo: "github.com/acme/lib", reason: "updated" });

    expect(entry.references).toHaveLength(1);
    expect(entry.references![0].reason).toBe("updated");
  });

  it("throws when target repo does not exist in index", () => {
    const entry = makeEntry("github.com", "acme", "app");
    const index: RepoIndex = { repos: [entry] };

    expect(() =>
      addReference(index, entry, { repo: "github.com/acme/missing" })
    ).toThrow("not found");
  });

  it("removes a reference by repo ID", () => {
    const entry = makeEntry("github.com", "acme", "app");
    const refEntry = makeEntry("github.com", "acme", "lib");
    const index: RepoIndex = { repos: [entry, refEntry] };

    addReference(index, entry, { repo: "github.com/acme/lib" });
    const removed = removeReference(entry, "github.com/acme/lib");

    expect(removed).toBe(true);
    expect(entry.references).toBeUndefined();
  });

  it("returns false when removing a reference that does not exist", () => {
    const entry = makeEntry("github.com", "acme", "app");
    const removed = removeReference(entry, "github.com/acme/nonexistent");
    expect(removed).toBe(false);
  });

  it("removes only the target reference leaving others intact", () => {
    const app = makeEntry("github.com", "acme", "app");
    const lib = makeEntry("github.com", "acme", "lib");
    const sdk = makeEntry("github.com", "acme", "sdk");
    const index: RepoIndex = { repos: [app, lib, sdk] };

    addReference(index, app, { repo: "github.com/acme/lib" });
    addReference(index, app, { repo: "github.com/acme/sdk" });

    removeReference(app, "github.com/acme/lib");

    expect(app.references).toHaveLength(1);
    expect(app.references![0].repo).toBe("github.com/acme/sdk");
  });
});
