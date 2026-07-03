/**
 * pi-adhd — Attention management extension for Pi.
 *
 * Features:
 *   - Session-scoped sticky notes (prompt/reminder/reference categories)
 *   - AI-assisted note capture with BAML/LLM/heuristic fallback
 *   - Two-column notes TUI viewer with vim navigation
 *   - Side-chat overlay (full btw replacement)
 *   - Turn-count reminders (status bar + toast)
 *   - Opt-in pinning (project or global persistence)
 *   - Session-end orphan overlay (best-effort)
 *
 * Commands:
 *   /note           — Open notes TUI
 *   /note <text>    — Capture a note (AI classify → form → confirm)
 *   /btw            — Open side-chat
 *   /btw <text>     — Open side-chat with pre-filled message
 *
 * Shortcuts:
 *   Ctrl+Shift+N    — Open notes TUI
 *   Ctrl+Alt+B      — Open side-chat
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseAdhDConfig, type AdhDConfig } from "./config.js";
import { NotesStore } from "./notes/store.js";
import { CATEGORIES } from "./notes/model.js";
import { classifyNote, classifyHeuristic, type ClassifyOptions } from "./notes/capture.js";
import { showNoteForm } from "./notes/form.js";
import { loadPinned, savePinned, removePinned, resolveRepoSlug } from "./notes/persistence.js";
import { createNotesTUI } from "./notes/tui.js";
import { createChatTUI } from "./chat/tui.js";
import { onTurnEnd, updateStatus } from "./reminders/tracker.js";
import { createShutdownOverlay } from "./reminders/shutdown.js";

export default function piAdhd(pi: ExtensionAPI) {
  let config: AdhDConfig;
  let store: NotesStore;
  let repoSlug = "global";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let baml: any = null;

  // ── Init ──────────────────────────────────────────────────────────────

  let settings: unknown = undefined;
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // No settings file — use defaults
  }

  try {
    config = parseAdhDConfig(settings);
  } catch {
    config = { reminderTurns: 8 };
  }

  store = new NotesStore();

  // ── BAML discovery (optional) ─────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.events.on("pi-baml:ready", (lib: any) => {
    baml = lib;
  });

  // ── Lifecycle events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Resolve repo slug for pinning
    try {
      repoSlug = resolveRepoSlug(process.cwd());
    } catch {
      repoSlug = "global";
    }

    // Load pinned notes
    try {
      const pinned = loadPinned(repoSlug);
      if (pinned.length > 0) {
        store.loadPinned(pinned);
        if (ctx.hasUI) {
          ctx.ui.notify(`📌 ${pinned.length} pinned note${pinned.length > 1 ? "s" : ""} from last session`, "info");
        }
      }
    } catch {
      // Non-critical — continue without pinned notes
    }

    updateStatus(store, ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    onTurnEnd(store, config, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const orphans = store.getOrphans();
    if (orphans.length === 0) return;

    try {
      await createShutdownOverlay(ctx, store, {
        onPin: (note, scope) => {
          store.update(note.id, { pinned: scope });
          savePinned({ ...note, pinned: scope }, scope, repoSlug);
        },
      });
    } catch {
      // Best-effort — if it fails, notes are lost
    }
  });

  // ── Context filtering ─────────────────────────────────────────────────

  pi.on("context", async (event, _ctx) => {
    const filtered = event.messages.filter((m) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = m as any;
      if (
        msg.role === "custom" &&
        typeof msg.customType === "string" &&
        msg.customType.startsWith("pi-adhd-")
      ) {
        return false;
      }
      return true;
    });
    return { messages: filtered };
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("note", {
    description: "Open notes TUI or add a note: /note, /note <text>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/note requires interactive mode", "error");
        return;
      }

      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        await openNotesTUI(ctx);
      } else {
        await captureNote(trimmed, ctx);
      }
    },
  });

  pi.registerCommand("btw", {
    description: "Open side-chat: /btw, /btw compact, /btw explain, /btw why, /btw help",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }

      const trimmed = (args ?? "").trim().toLowerCase();
      await openChat(ctx, trimmed || undefined);
    },
  });

  // ── Shortcuts ─────────────────────────────────────────────────────────

  pi.registerShortcut(Key.ctrlShift("n"), {
    description: "Open notes TUI",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await openNotesTUI(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("b"), {
    description: "Open side-chat",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await openChat(ctx);
    },
  });

  // ── Notes TUI ─────────────────────────────────────────────────────────

  async function openNotesTUI(ctx: ExtensionContext) {
    let pendingEditId: string | null = null;

    const runTUI = async () => {
      pendingEditId = null;
      await createNotesTUI(ctx, store, {
        onInject: (note) => {
          const result = store.inject(note.id);
          if (result.mode === "prompt") {
            pi.sendUserMessage(result.content);
          } else {
            pi.sendMessage(
              { customType: "pi-adhd-context", content: result.content, display: false },
              { triggerTurn: false },
            );
          }
        },
        onDelete: (note) => {
          if (note.pinned) {
            removePinned(note.id, note.pinned, repoSlug);
          }
          store.remove(note.id);
        },
        onPin: (note, scope) => {
          store.update(note.id, { pinned: scope });
          const updated = store.get(note.id);
          if (updated) {
            savePinned(updated, scope, repoSlug);
            ctx.ui.notify(`📌 Pinned: "${note.title}" (${scope})`, "info");
          }
        },
        onEdit: (note) => {
          pendingEditId = note.id;
        },
        onCycleCategory: (note) => {
          const idx = CATEGORIES.indexOf(note.category);
          const nextCategory = CATEGORIES[(idx + 1) % CATEGORIES.length]!;
          store.update(note.id, { category: nextCategory });
        },
        onStatusUpdate: () => {
          updateStatus(store, ctx);
        },
      });
    };

    await runTUI();

    // Handle edit after TUI closes
    while (pendingEditId) {
      const note = store.get(pendingEditId);
      if (!note) break;
      const newContent = await ctx.ui.editor(`Edit Note: ${note.title}`, note.content);
      if (newContent !== undefined && newContent !== note.content) {
        store.update(note.id, { content: newContent });
        ctx.ui.notify(`✓ Note updated: "${note.title}"`, "info");
      }
      // Re-open the TUI after editing
      await runTUI();
    }

    updateStatus(store, ctx);
  }

  // ── Note Capture ──────────────────────────────────────────────────────

  async function captureNote(text: string, ctx: ExtensionContext) {
    // AI classification with spinner
    const classified = await ctx.ui.custom<Awaited<ReturnType<typeof classifyNote>> | null>(
      (_tui, theme, _kb, done) => {
        const loader = new BorderedLoader(_tui, theme, `Classifying: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`);
        loader.onAbort = () => done(null);

        (async () => {
          try {
            const options: ClassifyOptions = {};

            // Tier 1: BAML
            if (baml?.available) {
              options.baml = baml;
            }

            // Tier 2: LLM
            if (ctx.model) {
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
              if (auth.ok && auth.apiKey) {
                options.model = {
                  id: ctx.model.id,
                  apiKey: auth.apiKey,
                  baseUrl: ctx.model.baseUrl,
                  ...(auth.headers ? { headers: auth.headers } : {}),
                };
              }
            }

            const result = await classifyNote(text, options);
            done(result);
          } catch {
            done(classifyHeuristic(text));
          }
        })();

        return loader;
      },
    );

    if (!classified) {
      ctx.ui.notify("Note capture cancelled", "info");
      return;
    }

    // Show preview form
    const note = await showNoteForm(ctx, classified);

    if (!note) {
      ctx.ui.notify("Note capture cancelled", "info");
      return;
    }

    store.add(note);
    updateStatus(store, ctx);
    ctx.ui.notify(`✓ Note added: "${note.title}" [${note.category}]`, "info");
  }

  // ── Side Chat ─────────────────────────────────────────────────────────

  // ── Quick templates for side-chat ───────────────────────────────────

  const TEMPLATES: Record<string, { needsContext: boolean; message?: string }> = {
    compact: { needsContext: true },
    explain: { needsContext: true, message: "Explain what you're currently doing and why." },
    why: { needsContext: true, message: "Why did you choose this approach?" },
    help: { needsContext: true, message: "What should I know about what you're working on?" },
  };

  async function getMainContextSummary(ctx: ExtensionContext): Promise<string | undefined> {
    const model = ctx.model;
    if (!model) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;

    // Get recent session entries for summarization
    const entries = ctx.sessionManager.getEntries();
    if (entries.length === 0) return undefined;

    // Build a rough transcript of recent messages
    const lines: string[] = [];
    for (const entry of entries.slice(-20)) {
      if (entry.type === "message" && "message" in entry) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (entry as any).message;
        if (msg.role === "user") {
          const text = (msg.content ?? [])
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("\n");
          if (text) lines.push(`User: ${text.slice(0, 500)}`);
        } else if (msg.role === "assistant") {
          const text = (msg.content ?? [])
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("\n");
          if (text) lines.push(`Assistant: ${text.slice(0, 500)}`);
        }
      }
    }

    if (lines.length === 0) return undefined;

    const { complete } = await import("@earendil-works/pi-ai");
    const result = await complete(
      model,
      {
        systemPrompt: "Summarize coding conversations concisely. Include: task, approach, current state, key decisions.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `Summarize this conversation context:\n\n${lines.join("\n\n").slice(0, 30000)}` }],
            timestamp: Date.now(),
          } as import("@earendil-works/pi-ai").Message,
        ],
      },
      { apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}) },
    );

    const summary = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary || undefined;
  }

  async function openChat(ctx: ExtensionContext, template?: string) {
    let extraContext: string | undefined;
    let initialMessage: string | undefined;

    if (template && TEMPLATES[template]) {
      const tmpl = TEMPLATES[template]!;
      if (tmpl.needsContext) {
        ctx.ui.notify("🧠 Summarizing main conversation...", "info");
        extraContext = await getMainContextSummary(ctx);
      }
      initialMessage = tmpl.message;
    }

    await createChatTUI(
      { ctx, extraContext, initialMessage },
      {
        onExit: async (result) => {
          if (!result) return; // discard

          switch (result.action) {
            case "inject":
            case "summarize-inject":
              pi.sendUserMessage(result.content);
              break;

            case "steer":
              pi.sendUserMessage(`[Side-chat insight] ${result.content}`);
              break;

            case "save-as-note": {
              // Run through capture flow for the summary
              await captureNote(result.content, ctx);
              break;
            }
          }
        },
      },
    );
  }

  // ── Message renderer ──────────────────────────────────────────────────

  pi.registerMessageRenderer("pi-adhd-context", (message, _options, _theme) => {
    return new Text(message.content as string, 0, 0);
  });
}
