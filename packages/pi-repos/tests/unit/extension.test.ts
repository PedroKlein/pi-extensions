import { describe, expect, it, vi } from "vitest";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { Value } from "typebox/value";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
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
  return {
    current,
    other,
    syncActive: 0,
    syncMaxActive: 0,
    generateTldr: vi.fn(),
  };
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
        "detail ".repeat(4_000),
    }),
  };
});

vi.mock("../../src/clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/clone.js")>();
  return {
    ...actual,
    cloneRepo: vi.fn().mockResolvedValue({
      ...fixture.other,
      tags: [],
      autoTags: [],
      starred: false,
      lastAccessed: "2026-01-01T00:00:00.000Z",
      addedAt: "2026-01-01T00:00:00.000Z",
      lastSyncedAt: null,
      commitsBehind: null,
    }),
    syncRepo: async () => {
      fixture.syncActive++;
      fixture.syncMaxActive = Math.max(fixture.syncMaxActive, fixture.syncActive);
      await new Promise((resolve) => setTimeout(resolve, 10));
      fixture.syncActive--;
      return { fetched: true };
    },
  };
});

vi.mock("../../src/summarize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/summarize.js")>();
  return { ...actual, generateTldr: fixture.generateTldr };
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
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    on: (name: string, handler: Handler) => listeners.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
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
  return { branch, listeners, messages, tools, ctx };
}

describe("pi-repos tool contract", () => {
  it("keeps every repo operation deferred behind one discoverable namespace", () => {
    const { tools } = createHarness();

    expect([...tools.keys()]).toEqual([
      "repos_add",
      "repos_info",
      "repos_list",
      "repos_remove",
      "repos_search",
      "repos_annotate",
      "repos_group",
      "repos_reference",
      "repos_sync",
    ]);
    const expectedAnnotations = {
      repos_add: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      repos_info: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      repos_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      repos_remove: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      repos_search: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      repos_annotate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      repos_group: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      repos_reference: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      repos_sync: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    } as const;
    for (const tool of tools.values()) {
      expect(tool.exposure).toBe("deferred");
      expect(tool.executionMode).toBe("sequential");
      expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
      expect(tool.namespace).toMatchObject({
        name: "repos",
        description: expect.stringContaining("repository"),
        instructions: expect.stringContaining("describeNamespace('repos')"),
      });
      expect(tool.outputSchema).toBeDefined();
      expect(JSON.stringify(tool.outputSchema)).toContain('"maxLength"');
      expect(JSON.stringify(tool.outputSchema)).toContain('"maxItems"');
      expect(JSON.stringify(tool.outputSchema)).toContain('"maxProperties"');
      expect(tool.annotations).toEqual(expectedAnnotations[tool.name as keyof typeof expectedAnnotations]);
    }
  });

  it("returns schema-valid bounded results from every repo tool", async () => {
    const { tools, ctx } = createHarness();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["repos_add", {}],
      ["repos_info", { repo: "github.com/example/current" }],
      ["repos_list", {}],
      ["repos_remove", { repo: "missing/repo" }],
      ["repos_search", { pattern: "needle" }],
      ["repos_annotate", {}],
      ["repos_group", { action: "unknown", name: "example" }],
      ["repos_reference", { action: "list" }],
      ["repos_sync", { repo: "missing/repo" }],
    ];

    for (const [name, params] of calls) {
      const tool = tools.get(name)!;
      const result = await tool.execute("call", params, undefined, undefined, ctx as ExtensionToolContext);
      expect(Value.Check(tool.outputSchema!, result.structuredContent), name).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.structuredContent)), name).toBeLessThanOrEqual(50 * 1024);
      if ((result.structuredContent as { ok: boolean }).ok === false) {
        expect(result.isError, name).toBe(true);
      }
    }

    expect((await tools.get("repos_info")!.execute(
      "call",
      { repo: "github.com/example/current" },
      undefined,
      undefined,
      ctx as ExtensionToolContext,
    )).structuredContent).toMatchObject({ ok: true, truncated: true });
    expect((await tools.get("repos_list")!.execute(
      "call",
      {},
      undefined,
      undefined,
      ctx as ExtensionToolContext,
    )).structuredContent).toMatchObject({
      ok: true,
      data: { total: 2 },
      truncated: false,
    });
  });

  it("serializes multi-repository syncs that update the shared index", async () => {
    fixture.syncActive = 0;
    fixture.syncMaxActive = 0;
    const { tools, ctx } = createHarness();

    const result = await tools.get("repos_sync")!.execute(
      "call",
      { all: true },
      undefined,
      undefined,
      ctx as ExtensionToolContext,
    );

    expect(result.isError).not.toBe(true);
    expect(fixture.syncMaxActive).toBe(1);
  });

  it("aborts and observes background summary work on session shutdown", async () => {
    fixture.generateTldr.mockReset();
    let observedSignal: AbortSignal | undefined;
    fixture.generateTldr.mockImplementation(
      async (_config, _entry, _metaDir, _modelCall, signal: AbortSignal) => {
        observedSignal = signal;
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    );
    const { tools, listeners, ctx } = createHarness();

    const result = await tools.get("repos_add")!.execute(
      "call",
      { url: "https://github.com/example/other" },
      undefined,
      undefined,
      ctx as ExtensionToolContext,
    );
    expect(result.isError).not.toBe(true);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await listeners.get("session_shutdown")?.({}, ctx);

    expect(observedSignal?.aborted).toBe(true);
  });

  it("exposes deferred repo tools to codemode discovery and calls", async () => {
    const { tools, ctx } = createHarness();
    let codemode: ToolDefinition | undefined;
    const callable = [...tools.values()];
    const toolsWithNamespace = Object.fromEntries(
      callable.map((tool) => [tool.name, { namespace: tool.namespace }]),
    );
    const toolContext = {
      ...ctx,
      tools: callable,
      executeTool: async (name: string, args: unknown) => {
        const tool = tools.get(name);
        if (!tool) {
          const result: AgentToolResult<unknown> = {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            details: {},
          };
          return { toolCall: { type: "toolCall", id: "nested", name, arguments: args }, result, isError: true };
        }
        const result = await tool.execute("nested", args as never, undefined, undefined, toolContext as ExtensionToolContext);
        return {
          toolCall: { type: "toolCall", id: "nested", name, arguments: args },
          result,
          isError: result.isError ?? false,
        };
      },
    } as unknown as ExtensionToolContext;

    createCodemodeExtension({ models: false })({
      registerTool: (tool: ToolDefinition) => { codemode = tool; },
      appendEntry: vi.fn(),
      getAllTools: () => callable.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: "deferred",
        namespace: toolsWithNamespace[tool.name]?.namespace,
        sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
      })),
      getSettings: () => ({}),
    } as unknown as ExtensionAPI);

    const loadout = {
      declared: [codemode!],
      callable,
      registered: [codemode!, ...callable],
      getExposure: (name: string) => name === "codemode" ? "model-only" as const : "deferred" as const,
      getNamespace: (name: string) => toolsWithNamespace[name]?.namespace,
    };
    const prepared = codemode!.prepareLoadout?.(loadout);
    codemode!.description = prepared?.descriptions?.codemode ?? codemode!.description;

    const result = await codemode!.execute("parent", {
      code: "const namespace = await describeNamespace('repos'); const found = await searchTools('list managed repositories', { namespace: 'repos' }); const described = await describeTool('repos_list'); const listed = await tools.repos_list({}); return { namespace, found, described, listed };",


    }, undefined, undefined, toolContext);
    const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");

    expect(result.isError).not.toBe(true);
    expect(output).toContain('"name":"repos"');
    expect(output).toContain('"instructions"');
    expect(output).toContain('"name":"repos_list"');
    expect(output).toContain("Promise<{");
    expect(output).not.toContain("Promise<unknown>");
    expect(output).toContain('"ok":true');
    expect(output).toContain('"total":2');
  });
});

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
    expect(harness.messages[1]?.content).toContain("tools.repos_info");
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
