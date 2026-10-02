import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateTldr } from "../../src/summarize.js";
import type { ModelCall } from "../../src/model-call.js";
import type { RepoEntry, ReposConfig } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-repos-summary-"));
  tempDirs.push(root);
  const repoPath = join(root, "repo");
  const metaDir = join(root, "meta");
  mkdirSync(repoPath);
  writeFileSync(
    join(repoPath, "README.md"),
    `# Widget\n\nReusable widget library.\n\n${"details ".repeat(10_000)}`,
  );
  const entry: RepoEntry = {
    host: "github.com",
    owner: "example",
    name: "widget",
    type: "local",
    url: null,
    path: repoPath,
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
  const config: ReposConfig = { storageDir: root, summaryModel: "router/auto" };
  return { entry, metaDir, config };
}

describe("repository summaries", () => {
  it("uses bounded repository context through the injected model runtime", async () => {
    const { entry, metaDir, config } = fixture();
    const signal = new AbortController().signal;
    const modelCall = vi.fn()
      .mockResolvedValueOnce("A reusable widget library.\nTYPE: library")
      .mockResolvedValueOnce("## Purpose\nReusable widgets for applications.") as unknown as ModelCall;

    await generateTldr(config, entry, metaDir, modelCall, signal);

    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(modelCall).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "router/auto",
      operation: "repo-tldr",
      signal,
      prompt: expect.stringContaining("Reusable widget library."),
    }));
    expect(modelCall).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: "repo-summary",
      prompt: expect.stringContaining("Reusable widget library."),
    }));
    for (const [request] of (modelCall as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect(Buffer.byteLength(request.prompt)).toBeLessThan(30_000);
    }
    expect(readFileSync(join(metaDir, "tldr.md"), "utf-8")).toContain("A reusable widget library.");
    expect(readFileSync(join(metaDir, "summary.md"), "utf-8")).toContain("Reusable widgets");
  });

  it("keeps the structural fallback when model work is unavailable", async () => {
    const { entry, metaDir, config } = fixture();
    const modelCall = vi.fn().mockRejectedValue(new Error("unavailable")) as unknown as ModelCall;

    await generateTldr(config, entry, metaDir, modelCall);

    expect(readFileSync(join(metaDir, "tldr.md"), "utf-8")).toContain("Repository: example/widget");
    expect(modelCall).toHaveBeenCalledTimes(2);
  });
});
