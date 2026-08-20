import { describe, expect, it, vi } from "vitest";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const fixture = vi.hoisted(() => {
  const current = {
    host: "github.com",
    owner: "example",
    name: "current",
    type: "cloned",
    path: "",
    defaultBranch: "main",
    worktrees: [
      { branch: "main", path: "/managed/repos/github.com/example/current" },
    ],
    references: [],
  };
  const other = {
    host: "github.com",
    owner: "example",
    name: "other",
    type: "cloned",
    path: "",
    defaultBranch: "main",
    worktrees: [{ branch: "main", path: "/workspace/other" }],
    references: [],
  };
  return { current, other };
});

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
    getPaths: () => ({
      repos: "/managed/repos",
      groups: "/managed/groups",
    }),
    expandTilde: (value: string) => value,
  };
});

vi.mock("../../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage.js")>();
  return {
    ...actual,
    ensureStorageDirs: () => undefined,
    loadIndex: () => ({ repos: [fixture.current, fixture.other] }),
    resolveRepo: (
      index: { repos: Array<typeof fixture.current> },
      id: string,
    ) => {
      const found = index.repos.find(
        (entry) => `${entry.host}/${entry.owner}/${entry.name}` === id,
      );
      if (!found) throw new Error(`missing ${id}`);
      return found;
    },
    repoId: (entry: typeof fixture.current) =>
      `${entry.host}/${entry.owner}/${entry.name}`,
    repoMetaDir: (_config: unknown, entry: typeof fixture.current) =>
      `/meta/${entry.name}`,
    readSummary: () => ({
      tldr:
        "OVERSIZED STORED SUMMARY\n\nSecond paragraph survives.\n\n" +
        "detail ".repeat(2_000),
    }),
  };
});

vi.mock("../../src/group.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/group.js")>();
  return {
    ...actual,
    listGroups: () => ["example-group"],
    getGroupInfo: () => ({
      name: "example-group",
      repos: [
        "github.com/example/current",
        "github.com/example/other",
      ],
      connections: [
        {
          from: "github.com/example/current",
          to: "github.com/example/other",
          relationship: "configures",
        },
      ],
      references: [],
    }),
  };
});

import piRepos from "../../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createHarness(branch: unknown[] = []) {
  const listeners = new Map<string, Handler>();
  const messages: Array<{ content: string }> = [];
  const pi = {
    on: (name: string, handler: Handler) => listeners.set(name, handler),
    registerTool: vi.fn(),
    sendMessage: (message: { content: string }) => messages.push(message),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/managed/repos/github.com/example/current",
    sessionManager: { getBranch: () => branch },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  piRepos(pi);
  return { branch, listeners, messages, ctx };
}

describe("pi-repos context injection", () => {
  it("keeps startup structural and injects one capped summary per active branch", async () => {
    const harness = createHarness();
    await harness.listeners.get("session_start")?.(
      { reason: "startup" },
      harness.ctx,
    );

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.content).toContain(
      "configures**: `github.com/example/other`",
    );
    expect(harness.messages[0]?.content).toContain("/workspace/other");
    expect(harness.messages[0]?.content).not.toContain("OVERSIZED STORED SUMMARY");

    await harness.listeners.get("tool_result")?.(
      {
        toolName: "read",
        input: { path: "/managed/repos/github.com/example/other/README.md" },
      },
      harness.ctx,
    );
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[1]?.content).toContain("OVERSIZED STORED SUMMARY");
    expect(harness.messages[1]?.content).toContain("Second paragraph survives");
    expect(harness.messages[1]?.content).toContain("repos_info");
    expect(encode(harness.messages[1]!.content).length).toBeLessThanOrEqual(500);

    await harness.listeners.get("session_start")?.(
      { reason: "resume" },
      harness.ctx,
    );
    await harness.listeners.get("tool_result")?.(
      {
        toolName: "read",
        input: { path: "/managed/repos/github.com/example/other/README.md" },
      },
      harness.ctx,
    );
    expect(harness.messages).toHaveLength(2);

    const forkBeforeMarker = createHarness([]);
    await forkBeforeMarker.listeners.get("session_start")?.(
      { reason: "fork" },
      forkBeforeMarker.ctx,
    );
    await forkBeforeMarker.listeners.get("tool_result")?.(
      {
        toolName: "read",
        input: { path: "/managed/repos/github.com/example/other/README.md" },
      },
      forkBeforeMarker.ctx,
    );
    expect(forkBeforeMarker.messages).toHaveLength(2);
  });
});
