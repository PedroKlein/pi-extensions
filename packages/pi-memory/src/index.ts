import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildDeterministicBlock, projectSlug, type ContextBlock } from "./injector.js";
import { MemoryStore, type MemoryScope } from "./store.js";

type ToolResult = AgentToolResult<unknown>;

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function dataResult(
  text: string,
  structuredContent: NonNullable<ToolResult["structuredContent"]>,
): ToolResult {
  return { content: [{ type: "text", text }], details: {}, structuredContent };
}

const MemoryFactSchema = Type.Object({
  key: Type.String({ maxLength: 512 }),
  value: Type.String({ maxLength: 4096 }),
  confidence: Type.Number(),
  source: Type.String({ maxLength: 100 }),
});
const MemorySearchOutput = Type.Object({
  results: Type.Array(MemoryFactSchema, { maxItems: 100 }),
  count: Type.Integer({ minimum: 0, maximum: 100 }),
  total: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  scope: Type.Union([
    Type.Literal("current"),
    Type.Literal("global"),
    Type.Literal("all"),
  ]),
  project: Type.String({ maxLength: 200 }),
  truncated: Type.Boolean(),
});
const MemoryStatsOutput = Type.Object({
  semantic: Type.Integer({ minimum: 0 }),
  events: Type.Integer({ minimum: 0 }),
  pinned: Type.Integer({ minimum: 0 }),
  dbPath: Type.String({ maxLength: 4096 }),
});

const memoryQueryContract = {
  exposure: "direct" as const,
  executionMode: "sequential" as const,
  constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const memoryMutationContract = {
  exposure: "direct" as const,
  executionMode: "sequential" as const,
  constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

const DEFAULT_DB_PATH = join(homedir(), ".pi", "memory", "memory.db");

function bounded(value: string, maxLength: number): { value: string; truncated: boolean } {
  if (value.length <= maxLength) return { value, truncated: false };
  return { value: value.slice(0, maxLength), truncated: true };
}

function stripQuotes<T>(value: T): T {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length < 2) return value;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== '"' || last !== '"') && (first !== "'" || last !== "'")) {
    return value;
  }

  try {
    if (first === '"') return JSON.parse(trimmed) as unknown as T;
  } catch {
    // Fall through to stripping one quote layer.
  }
  return trimmed.slice(1, -1) as unknown as T;
}

function resolveDbPath(cwd: string): string {
  try {
    const settings = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8"));
    const localPath = settings?.["pi-memory"]?.localPath;
    if (typeof localPath === "string" && localPath) {
      const directory = isAbsolute(localPath) ? localPath : resolve(cwd, localPath);
      return join(directory, "memory.db");
    }
  } catch {
    // Use the global store when no project override exists.
  }
  return DEFAULT_DB_PATH;
}

export default function piMemory(pi: ExtensionAPI): void {
  let store: MemoryStore | null = null;
  let sessionCwd = "";
  let resolvedDbPath = DEFAULT_DB_PATH;
  let cachedMemoryBlock: ContextBlock | null = null;

  const assertCurrentProjectKey = (key: string): void => {
    const project = projectSlug(sessionCwd);
    if (!isVisibleInCurrentScope(key, project)) {
      throw new Error(`Project memory key must use the current repository slug: project.${project}.*`);
    }
  };

  const refreshMemoryBlock = (): void => {
    if (!store) {
      cachedMemoryBlock = null;
      return;
    }
    cachedMemoryBlock = buildDeterministicBlock(store, sessionCwd);
  };

  pi.registerMessageRenderer("pi-memory-snapshot", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("muted", content), 0, 0);
  });

  pi.on("context", async (event) => ({
    messages: (event as any).messages.filter(
      (message: any) => message.role !== "custom" || message.customType !== "pi-memory-snapshot",
    ),
  }));

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionCwd = ctx.cwd;
      resolvedDbPath = resolveDbPath(sessionCwd);
      store = new MemoryStore(resolvedDbPath);
      cachedMemoryBlock = buildDeterministicBlock(store, sessionCwd, {
        onBudgetExceeded: (message) => ctx.ui.notify(message, "warning"),
      });

      const stats = store.stats();
      if (stats.semantic > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${stats.semantic} facts`);
        setTimeout(() => {
          try {
            ctx.ui.setStatus("pi-memory", "");
          } catch {
            // The session context may have been replaced.
          }
        }, 5_000);
      }

      if (ctx.hasUI && cachedMemoryBlock.factKeys.length > 0) {
        const visibleKeys = new Set(cachedMemoryBlock.factKeys);
        const lines = [
          cachedMemoryBlock.displayLine,
          ...store.listPinned()
            .filter((fact) => visibleKeys.has(fact.key))
            .map((fact) => `  📌 ${fact.key}: ${fact.value}`),
        ];
        pi.sendMessage(
          { customType: "pi-memory-snapshot", content: lines.join("\n"), display: true },
          { triggerTurn: false },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-memory: failed to open store: ${message}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (cachedMemoryBlock?.text) {
      event.systemPromptOptions.sections.memory = cachedMemoryBlock.text;
    } else {
      delete event.systemPromptOptions.sections.memory;
    }
  });

  pi.on("session_shutdown", async () => {
    store?.close();
    store = null;
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search or list curated memory. Defaults to global facts plus the current repository; use scope='all' only for explicit cross-repository audits.",
    promptSnippet: "Search curated memory scoped to the current repository by default.",
    promptGuidelines: [
      "Search memory when a durable user preference or project decision may affect the task.",
      "Treat current repository files and instructions as authoritative when they conflict with memory.",
      "Use scope='all' only when the user explicitly asks for a cross-repository memory audit.",
    ],
    ...memoryQueryContract,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query; omit to list facts" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("current"),
        Type.Literal("global"),
        Type.Literal("all"),
      ], { description: "current (default), global, or all repositories" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Pagination offset (default 0)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 10)" })),
    }),
    outputSchema: MemorySearchOutput,
    async execute(_id, params) {
      if (!store) throw new Error("Memory store not initialized");

      const limit = params.limit ?? 10;
      const offset = params.offset ?? 0;
      const scope = (params.scope ?? "current") as MemoryScope;
      const project = projectSlug(sessionCwd);
      const { entries, total } = store.querySemantic({
        query: params.query,
        scope,
        project,
        limit,
        offset,
      });
      let truncated = offset + entries.length < total;
      const results = entries.map((entry) => {
        const key = bounded(entry.key, 512);
        const value = bounded(entry.value, 4096);
        truncated ||= key.truncated || value.truncated;
        return { key: key.value, value: value.value, confidence: entry.confidence, source: entry.source };
      });
      const structuredContent = {
        results,
        count: results.length,
        total,
        offset,
        nextOffset: offset + results.length < total ? offset + results.length : null,
        scope,
        project,
        truncated,
      };
      const text = results.length === 0
        ? "No matching memories found."
        : results.map((result) =>
          `${result.key}: ${result.value} (confidence: ${result.confidence}, source: ${result.source})`
        ).join("\n");
      return dataResult(text, structuredContent);
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store one durable fact or preference. Do not store session state, repository-derived facts, or credentials.",
    ...memoryMutationContract,
    parameters: Type.Object({
      key: Type.String({ description: "Dotted key such as pref.editor or project.rosie.workflow" }),
      value: Type.String({ description: "Concise durable value" }),
      pinned: Type.Optional(Type.Boolean({ description: "Pin for automatic prompt injection" })),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("Memory store not initialized");

      const key = stripQuotes(params.key);
      const value = stripQuotes(params.value);
      assertCurrentProjectKey(key);
      store.setSemantic(key, value, 0.95, "user");
      if (params.pinned) store.pin(key);
      refreshMemoryBlock();
      return ok(`Remembered: ${key}${params.pinned ? " (📌 pinned)" : ""}`);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove one fact from curated memory.",
    ...memoryMutationContract,
    parameters: Type.Object({
      key: Type.String({ description: "Fact key to remove" }),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("Memory store not initialized");

      const key = stripQuotes(params.key);
      assertCurrentProjectKey(key);
      const deleted = store.deleteSemantic(key);
      if (deleted) refreshMemoryBlock();
      return ok(deleted ? `Forgot: ${key}` : `Not found: ${key}`);
    },
  });

  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show curated-memory statistics and the active database path.",
    ...memoryQueryContract,
    parameters: Type.Object({}),
    outputSchema: MemoryStatsOutput,
    async execute() {
      if (!store) throw new Error("Memory store not initialized");

      const stats = store.stats();
      const pinned = store.listPinned().length;
      const structuredContent = {
        semantic: stats.semantic,
        events: stats.events,
        pinned,
        dbPath: resolvedDbPath.slice(0, 4096),
      };
      return dataResult(
        `Memory: ${stats.semantic} facts (${pinned} pinned), ${stats.events} events logged\nDB: ${resolvedDbPath}`,
        structuredContent,
      );
    },
  });

  pi.registerTool({
    name: "memory_pin",
    label: "Memory Pin",
    description: "Pin or unpin a fact for scoped automatic prompt injection.",
    promptSnippet: "Pin or unpin a curated fact.",
    ...memoryMutationContract,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("list")]),
      key: Type.Optional(Type.String({ description: "Fact key for pin or unpin" })),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("Memory store not initialized");

      const action = stripQuotes(params.action);
      const key = stripQuotes(params.key);
      if (action === "list") {
        const project = projectSlug(sessionCwd);
        const pinned = store.listPinned()
          .filter((fact) => isVisibleInCurrentScope(fact.key, project));
        return ok(pinned.length === 0
          ? "No pinned facts."
          : pinned.map((fact) => `📌 ${fact.key}: ${fact.value}`).join("\n"));
      }
      if (!key) throw new Error(`Key required for ${action} action`);
      assertCurrentProjectKey(key);
      if (action === "pin") {
        if (!store.pin(key)) throw new Error(`Fact not found: ${key}`);
        refreshMemoryBlock();
        return ok(`📌 Pinned: ${key}`);
      }

      if (!store.unpin(key)) throw new Error(`Fact not found or not pinned: ${key}`);
      refreshMemoryBlock();
      return ok(`Unpinned: ${key}`);
    },
  });
}

function isVisibleInCurrentScope(key: string, project: string): boolean {
  const normalized = key.toLowerCase();
  return !normalized.startsWith("project.") || normalized.startsWith(`project.${project}.`);
}
