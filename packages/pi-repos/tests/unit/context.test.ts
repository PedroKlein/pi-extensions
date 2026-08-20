import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import {
  buildRepoSummaryContext,
  injectedRepoIdsFromBranch,
} from "../../src/context.js";

describe("repository context lifecycle", () => {
  it("hydrates injected repositories from active-branch markers only", () => {
    const branch = [
      {
        type: "custom",
        customType: "pi-repos-injected-marker",
        data: { repoId: "github.com/example/repo-a" },
      },
      {
        type: "custom_message",
        customType: "pi-repos-context",
        content: "display text is not the dedup source",
      },
    ];

    expect([...injectedRepoIdsFromBranch(branch)]).toEqual([
      "github.com/example/repo-a",
    ]);
    expect([...injectedRepoIdsFromBranch([])]).toEqual([]);
  });

  it("includes the stored TLDR once and caps oversized text with a repos_info pointer", () => {
    const tldr = [
      "Repository overview with important architecture.",
      "Second paragraph must remain available when budget permits.",
      "detail ".repeat(2_000),
    ].join("\n\n");

    const result = buildRepoSummaryContext(
      "github.com/example/repo-a",
      tldr,
    );

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("Repository overview");
    expect(result.content).toContain("Second paragraph");
    expect(result.content).toContain("repos_info");
    expect(encode(result.content).length).toBeLessThanOrEqual(500);
  });
});
