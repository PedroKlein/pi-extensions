import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroup } from "../../src/group.js";
import { suggestConnections } from "../../src/suggest.js";
import { ensureStorageDirs, repoMetaDir, saveIndex, writeTldr } from "../../src/storage.js";
import type { ModelCall } from "../../src/model-call.js";
import type { RepoEntry, ReposConfig } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(name: string): RepoEntry {
  return {
    host: "github.com",
    owner: "example",
    name,
    type: "local",
    url: null,
    path: `/tmp/${name}`,
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

describe("repository connection suggestions", () => {
  it("uses the injected model runtime and preserves validated suggestions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-repos-suggest-"));
    tempDirs.push(root);
    const config: ReposConfig = { storageDir: root, summaryModel: "router/auto" };
    const source = entry("source");
    const target = entry("target");
    ensureStorageDirs(config);
    saveIndex(config, { repos: [source, target] });
    writeTldr(repoMetaDir(config, source), "Produces an API.", "rev-a");
    writeTldr(repoMetaDir(config, target), "Consumes the source API.", "rev-b");
    createGroup(config, "system", "Example system", [
      "github.com/example/source",
      "github.com/example/target",
    ]);
    const signal = new AbortController().signal;
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify([
      {
        from: "github.com/example/target",
        to: "github.com/example/source",
        relationship: "depends-on",
        description: "The target calls the source API.",
        confidence: "high",
      },
      {
        from: "missing/repo",
        to: "github.com/example/source",
        relationship: "depends-on",
        description: "Invalid member.",
        confidence: "low",
      },
    ])) as unknown as ModelCall;

    await expect(suggestConnections(config, "system", modelCall, signal)).resolves.toEqual([
      expect.objectContaining({
        from: "github.com/example/target",
        to: "github.com/example/source",
        relationship: "depends-on",
      }),
    ]);
    expect(modelCall).toHaveBeenCalledWith(expect.objectContaining({
      model: "router/auto",
      operation: "group-suggest",
      signal,
      prompt: expect.stringContaining("Produces an API."),
    }));
  });
});
