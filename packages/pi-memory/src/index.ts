/**
 * pi-memory — Persistent memory extension for pi.
 *
 * Learns corrections, preferences, and patterns from sessions.
 * Injects relevant memory into future conversations.
 *
 * Lifecycle:
 * - session_start: open store, build deterministic memory block, cache it
 * - before_agent_start: inject cached memory block into system prompt
 * - agent_end: queue messages for consolidation
 * - session_shutdown: consolidate and close store
 *
 * Tools:
 * - memory_search: search semantic memory
 * - memory_remember: manually add a memory
 * - memory_forget: delete a memory
 * - memory_lessons: list learned corrections
 * - memory_stats: show memory statistics
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { buildDeterministicBlock, loadCategoryMap, type ContextBlock } from "./injector.js";
import {
  buildConsolidationPrompt,
  parseConsolidationResponse,
  applyExtracted,
  type ConsolidationInput,
} from "./consolidator.js";
import { readDreamConfig } from "./dream/config.js";
import { checkGates, executeDream } from "./dream/orchestrator.js";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult { return { content: [{ type: "text", text }], details: {} }; }

/**
 * Strip one layer of surrounding quotes from a string value.
 * Some local models (e.g. Qwen on certain runners) double-JSON-encode tool
 * arguments, emitting `"\"fact\""` instead of `"fact"`. We defensively
 * unwrap so these calls don't fail schema validation / equality checks.
 */
function stripQuotes<T>(v: T): T {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      try {
        if (first === '"') return JSON.parse(s) as unknown as T;
      } catch { /* fall through */ }
      return s.slice(1, -1) as unknown as T;
    }
  }
  return v;
}

/** Consolidation subprocess sessions go here — separate from main sessions to avoid dream feedback loop */
const CONSOLIDATION_SESSIONS_DIR = join(homedir(), ".pi", "memory", "dream-sessions");

const DEFAULT_MEMORY_DIR = join(homedir(), ".pi", "memory");
const DEFAULT_DB_PATH = join(DEFAULT_MEMORY_DIR, "memory.db");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Resolve the memory DB path for a given working directory.
 * Priority:
 *   1. "pi-memory".localPath from {cwd}/.pi/settings.json → join(localPath, "memory.db")
 *   2. Global default: ~/.pi/memory/memory.db
 */
function resolveDbPath(cwd: string): string {
  try {
    const localSettingsPath = join(cwd, ".pi", "settings.json");
    const raw = readFileSync(localSettingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const piMemory = settings?.["pi-memory"];
    if (piMemory && typeof piMemory === "object" && typeof piMemory.localPath === "string" && piMemory.localPath) {
      return join(piMemory.localPath, "memory.db");
    }
  } catch {
    // No local settings or parse error — use global default
  }
  return DEFAULT_DB_PATH;
}

/**
 * Memory extension config.
 */
interface MemoryConfig {
  consolidationEnabled: boolean;
  consolidationModel?: string;
}

/**
 * Read pi-memory config from settings.json.
 */
function readSettingsConfig(cwd?: string): MemoryConfig {
  const config: MemoryConfig = { consolidationEnabled: false };

  // Read global settings
  try {
    const raw = readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    const memorySettings = settings?.memory;
    if (memorySettings && typeof memorySettings === "object") {
      if (typeof memorySettings.consolidationEnabled === "boolean") {
        config.consolidationEnabled = memorySettings.consolidationEnabled;
      }
      if (typeof memorySettings.consolidationModel === "string" && memorySettings.consolidationModel) {
        config.consolidationModel = memorySettings.consolidationModel;
      }
    }
    // Fallback: use defaultModel from settings if no consolidationModel specified
    if (!config.consolidationModel && settings?.defaultModel) {
      config.consolidationModel = settings.defaultModel;
    }
  } catch {
    // no global settings
  }

  // Override with local project settings if available
  if (cwd) {
    try {
      const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
      const settings = JSON.parse(raw);
      const memorySettings = settings?.memory ?? settings?.["pi-memory"];
      if (memorySettings && typeof memorySettings === "object") {
        if (typeof memorySettings.consolidationEnabled === "boolean") {
          config.consolidationEnabled = memorySettings.consolidationEnabled;
        }
        if (typeof memorySettings.consolidationModel === "string" && memorySettings.consolidationModel) {
          config.consolidationModel = memorySettings.consolidationModel;
        }
      }
    } catch {
      // no local settings
    }
  }

  return config;
}

export default function (pi: ExtensionAPI) {
  let store: MemoryStore | null = null;
  let pendingUserMessages: string[] = [];
  let pendingAssistantMessages: string[] = [];
  let sessionCwd: string = "";
  let sessionId: string | undefined;
  let cachedCtx: any = null;
  let resolvedDbPath: string = DEFAULT_DB_PATH;
  let memoryConfig: MemoryConfig = readSettingsConfig();

  // Cached memory block — built once at session_start, injected every turn
  let cachedMemoryBlock: ContextBlock | null = null;

  // ─── Message renderers for memory display ────────────────────────
  pi.registerMessageRenderer("pi-memory", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("muted", content), 0, 0);
  });

  pi.registerMessageRenderer("pi-memory-snapshot", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("muted", content), 0, 0);
  });

  // Filter memory snapshot out of LLM context (visual-only, not sent to model)
  pi.on("context", async (event, _ctx) => {
    const filtered = (event as any).messages.filter((m: any) => {
      if (m.role === "custom" && m.customType === "pi-memory-snapshot") return false;
      return true;
    });
    return { messages: filtered };
  });

  // ─── Lifecycle ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionCwd = ctx.cwd;
      cachedCtx = ctx;
      sessionId = (ctx as any).sessionId ?? (ctx as any).session?.id;

      // Resolve per-agent DB path from local settings or cwd
      resolvedDbPath = resolveDbPath(sessionCwd);
      memoryConfig = readSettingsConfig(sessionCwd);

      store = new MemoryStore(resolvedDbPath);

      // Build deterministic memory block (once, cached for session)
      const categoryMap = loadCategoryMap();
      cachedMemoryBlock = buildDeterministicBlock(store, sessionCwd, categoryMap);

      // Seed pending messages from existing session history so that
      // /memory-consolidate works even when resuming a session.
      pendingUserMessages = [];
      pendingAssistantMessages = [];
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          if (entry.type !== "message") continue;
          const msg = (entry as any).message;
          if (!msg) continue;
          if (msg.role === "user") {
            const text = extractText(msg.content);
            if (text) pendingUserMessages.push(text);
          } else if (msg.role === "assistant") {
            const text = extractText(msg.content);
            if (text) pendingAssistantMessages.push(text);
          }
        }
      } catch {
        // Session may not have entries yet (brand-new session)
      }

      const stats = store.stats();
      if (stats.semantic + stats.lessons > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${stats.semantic} facts, ${stats.lessons} lessons`);
        setTimeout(() => { try { ctx.ui.setStatus("pi-memory", ""); } catch { /* ctx may be stale after session replacement */ } }, 5000);
      }

      // Show pinned memory snapshot at session init (visual only, filtered from LLM context)
      if (ctx.hasUI && cachedMemoryBlock && cachedMemoryBlock.factKeys.length > 0) {
        const pinnedFacts = store.listPinned();
        const lines: string[] = [cachedMemoryBlock.displayLine];
        for (const fact of pinnedFacts) {
          lines.push(`  📌 ${fact.key}: ${fact.value}`);
        }
        pi.sendMessage(
          { customType: "pi-memory-snapshot", content: lines.join("\n"), display: true },
          { triggerTurn: false },
        );
      }

      // Auto-trigger Dream (fire-and-forget)
      try {
        const dreamConfig = readDreamConfig(sessionCwd);
        if (dreamConfig.enabled && dreamConfig.autoTrigger) {
          if (checkGates(store, dreamConfig)) {
            void executeDream(
              store,
              dreamConfig,
              (cmd, args, opts) => pi.exec(cmd, args, opts),
              ctx.ui,
              { manual: false }
            ).catch((err) => {
              ctx.ui.notify(`Dream failed: ${err?.message?.slice(0, 100) || "unknown error"}`, "error");
            });
          }
        }
      } catch {
        // Dream auto-trigger failure is non-fatal
      }
    } catch (err: any) {
      ctx.ui.notify(`pi-memory: failed to open store: ${err.message}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!store || !cachedMemoryBlock || !cachedMemoryBlock.text) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${cachedMemoryBlock.text}`,
    };
  });

  pi.on("agent_end", async (event, _ctx) => {
    // Collect messages for consolidation at shutdown
    for (const msg of event.messages) {
      if (msg.role === "user" && "content" in msg) {
        const text = extractText(msg.content);
        if (text) {
          pendingUserMessages.push(text);
          if (pendingUserMessages.length > 60) pendingUserMessages.shift();
        }
      } else if (msg.role === "assistant" && "content" in msg) {
        const text = extractText(msg.content);
        if (text) {
          pendingAssistantMessages.push(text);
          if (pendingAssistantMessages.length > 60) pendingAssistantMessages.shift();
        }
      }
    }
  });

  // Consolidate memory when switching sessions (/new, /resume)
  pi.on("session_before_switch", async (_event, ctx) => {
    if (!store) return;

    if (memoryConfig.consolidationEnabled && pendingUserMessages.length >= 3) {
      ctx.ui.setStatus("pi-memory", "🧠 Consolidating memory...");
      try {
        await consolidateSession();
      } catch {
        // Best-effort
      }
      ctx.ui.setStatus("pi-memory", "");
    }

    // Reset for the next session
    pendingUserMessages = [];
    pendingAssistantMessages = [];
    cachedMemoryBlock = null;
  });

  pi.on("session_shutdown", async () => {
    if (!store) return;

    // Consolidate if enabled and we have enough conversation
    if (memoryConfig.consolidationEnabled && pendingUserMessages.length >= 3) {
      if (cachedCtx) {
        cachedCtx.ui.setStatus("pi-memory", "🧠 Consolidating memory...");
      }
      try {
        await consolidateSession();
      } catch {
        // Best-effort — don't crash on shutdown
      }
    }

    store.close();
    store = null;
  });

  // ─── Consolidation ──────────────────────────────────────────────

  async function consolidateSession(): Promise<void> {
    if (!store) return;

    const input: ConsolidationInput = {
      userMessages: pendingUserMessages,
      assistantMessages: pendingAssistantMessages,
      cwd: sessionCwd,
      sessionId,
    };

    const currentFacts = store.listSemantic(undefined, 600).map(f => ({ key: f.key, value: f.value }));
    const currentLessons = store.listLessons(undefined, 200).map(l => ({ rule: l.rule, category: l.category }));

    const prompt = buildConsolidationPrompt(input, currentFacts, currentLessons);
    const model = memoryConfig.consolidationModel || "github-copilot/claude-sonnet-4.6";
    try {
      const result = await pi.exec("pi", [
        "-p", prompt,
        "--print",
        "--no-extensions",
        "--model", model,
        "--session-dir", CONSOLIDATION_SESSIONS_DIR,
      ], {
        timeout: 45_000,
        cwd: sessionCwd,
      });

      if (result.code === 0 && result.stdout) {
        const extracted = parseConsolidationResponse(result.stdout);
        const applied = applyExtracted(store!, extracted, `session:${sessionId ?? "unknown"}`);
        if (applied.semantic + applied.lessons > 0) {
          console.error(`pi-memory: consolidated ${applied.semantic} facts, ${applied.lessons} lessons`);
        }
      }
    } catch {
      // Timeout or exec failure — skip consolidation this session
    }
  }

  // ─── Tools ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    promptSnippet: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    promptGuidelines: [
      "Use memory_search PROACTIVELY at the start of tasks to load relevant project context, user preferences, and known issues.",
      "Search before making assumptions about user workflow, coding style, or project architecture.",
      "On errors or unexpected behavior, search memory for the error domain BEFORE retrying.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const results = store.searchSemantic(params.query, params.limit ?? 10);
      if (results.length === 0) {
        return ok("No matching memories found.");
      }

      const text = results.map(r =>
        `${r.key}: ${r.value} (confidence: ${r.confidence}, source: ${r.source})`
      ).join("\n");

      return ok(text);
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact, preference, or lesson in persistent memory. Use dotted keys like pref.editor, project.rosie.lang, tool.sed.usage. For corrections, use type='lesson'.",
    parameters: Type.Object({
      type: Type.String({ description: "'fact' for key-value, 'lesson' for a correction" }),
      key: Type.Optional(Type.String({ description: "Dotted key for facts (e.g. pref.commit_style)" })),
      value: Type.Optional(Type.String({ description: "Value for facts" })),
      rule: Type.Optional(Type.String({ description: "Rule text for lessons" })),
      category: Type.Optional(Type.String({ description: "Category for lessons (default: general)" })),
      negative: Type.Optional(Type.Boolean({ description: "True if this is something to AVOID" })),
      pinned: Type.Optional(Type.Boolean({ description: "Pin this fact so it's always injected into context (use sparingly — only for critical behavioral preferences)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      params = {
        ...params,
        type: stripQuotes(params.type),
        key: stripQuotes(params.key),
        value: stripQuotes(params.value),
        rule: stripQuotes(params.rule),
        category: stripQuotes(params.category),
      };

      if (params.type !== "fact" && params.type !== "lesson") {
        return ok(`Invalid type: ${params.type}. Must be 'fact' or 'lesson'.`);
      }

      if (params.type === "fact") {
        if (!params.key || !params.value) {
          return ok("Both key and value required for facts");
        }
        store.setSemantic(params.key, params.value, 0.95, "user");
        if (params.pinned) {
          store.pin(params.key);
        }
        const pinnedTag = params.pinned ? " (📌 pinned)" : "";
        return ok(`Remembered: ${params.key} = ${params.value}${pinnedTag}`);
      }

      if (params.type === "lesson") {
        if (!params.rule) {
          return ok("Rule text required for lessons");
        }
        const result = store.addLesson(params.rule, params.category ?? "general", "user", params.negative ?? false);
        if (result.success) {
          return ok(`Lesson learned: ${params.rule}`);
        }
        return ok(`Already known (${result.reason}): ${params.rule}`);
      }

      return ok("Unknown type");
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or lesson from persistent memory.",
    parameters: Type.Object({
      type: Type.String(),
      key: Type.Optional(Type.String({ description: "Key for facts" })),
      id: Type.Optional(Type.String({ description: "ID for lessons" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      params = {
        ...params,
        type: stripQuotes(params.type),
        key: stripQuotes(params.key),
        id: stripQuotes(params.id),
      };

      if (params.type !== "fact" && params.type !== "lesson") {
        return ok(`Invalid type: ${params.type}. Must be 'fact' or 'lesson'.`);
      }

      if (params.type === "fact" && params.key) {
        const deleted = store.deleteSemantic(params.key);
        return ok(deleted ? `Forgot: ${params.key}` : `Not found: ${params.key}`);
      }

      if (params.type === "lesson" && params.id) {
        const deleted = store.deleteLesson(params.id);
        return ok(deleted ? `Forgot lesson ${params.id}` : `Not found: ${params.id}`);
      }

      return ok("Provide key (for facts) or id (for lessons)");
    },
  });

  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and lessons from past sessions.",
    promptGuidelines: [
      "Check memory_lessons when entering a domain where past mistakes were made (e.g., Go error handling, CI workflows, PR scope).",
    ],
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const lessons = store.listLessons(params.category, params.limit ?? 50);
      if (lessons.length === 0) {
        return ok("No lessons learned yet.");
      }

      const text = lessons.map(l =>
        `${l.negative ? "❌" : "✅"} [${l.category}] ${l.rule} (id: ${l.id.slice(0, 8)})`
      ).join("\n");

      return ok(text);
    },
  });

  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show memory statistics — how many facts, lessons, and events are stored.",
    parameters: Type.Object({}) as any,
    async execute(_id, _params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const stats = store.stats();
      const pinned = store.listPinned();
      const text = `Memory: ${stats.semantic} semantic facts (${pinned.length} pinned), ${stats.lessons} active lessons, ${stats.events} events logged\nDB: ${resolvedDbPath}`;
      return ok(text);
    },
  });

  pi.registerTool({
    name: "memory_pin",
    label: "Memory Pin",
    description: "Pin or unpin a fact for always-on context injection. Pinned facts are injected into every turn's system prompt. Use sparingly — only for critical behavioral preferences that prevent repeated mistakes.",
    promptSnippet: "Pin/unpin facts for always-on context injection",
    parameters: Type.Object({
      action: Type.String({ description: "'pin' to pin, 'unpin' to unpin, 'list' to show all pinned" }),
      key: Type.Optional(Type.String({ description: "Fact key to pin/unpin (required for pin/unpin)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const action = stripQuotes(params.action);
      const key = stripQuotes(params.key);

      if (action === "list") {
        const pinned = store.listPinned();
        if (pinned.length === 0) return ok("No pinned facts. Use memory_pin with action='pin' to pin important preferences.");
        const lines = pinned.map(f => `📌 ${f.key}: ${f.value}`);
        return ok(lines.join("\n"));
      }

      if (action === "pin") {
        if (!key) return ok("Key required for pin action");
        const entry = store.getSemantic(key);
        if (!entry) return ok(`Fact not found: ${key}. Create it first with memory_remember.`);
        store.pin(key);
        return ok(`📌 Pinned: ${key} = ${entry.value}`);
      }

      if (action === "unpin") {
        if (!key) return ok("Key required for unpin action");
        const success = store.unpin(key);
        return ok(success ? `Unpinned: ${key}` : `Not found or not pinned: ${key}`);
      }

      return ok("Invalid action. Use 'pin', 'unpin', or 'list'.");
    },
  });

  // ─── Commands ──────────────────────────────────────────────────

  pi.registerCommand("dream", {
    description: "Run memory Dream — processes unprocessed sessions, refines memory with skill context, produces a journal",
    async handler(_args, ctx) {
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }

      const dreamConfig = readDreamConfig(sessionCwd);
      if (!dreamConfig.enabled) {
        ctx.ui.notify("Dream is disabled in settings (memory.dream.enabled = false)", "warning");
        return;
      }

      ctx.ui.notify("Starting Dream...", "info");
      try {
        const result = await executeDream(
          store,
          dreamConfig,
          (cmd, args, opts) => pi.exec(cmd, args, opts),
          ctx.ui,
          { manual: true }
        );

        if (!result.success) {
          ctx.ui.notify(`Dream failed: ${result.error || "unknown error"}`, "error");
        }
      } catch (err: any) {
        ctx.ui.notify(`Dream error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation for the current session",
    async handler(_args, ctx) {
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }

      if (pendingUserMessages.length < 2) {
        ctx.ui.notify("Not enough conversation to consolidate (need at least 2 user messages)", "warning");
        return;
      }

      ctx.ui.notify("Consolidating session memory...", "info");
      try {
        await consolidateSession();
        const stats = store.stats();
        ctx.ui.notify(`Memory updated: ${stats.semantic} facts, ${stats.lessons} lessons`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Consolidation failed: ${err.message}`, "error");
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}
