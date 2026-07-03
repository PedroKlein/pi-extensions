/**
 * Chat TUI overlay — side-chat with model picker, streaming, and exit actions.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ChatEngine } from "./engine.js";
import { EXIT_ACTIONS, executeExitAction, type ExitResult } from "./actions.js";

export interface ChatTUICallbacks {
  onExit: (result: ExitResult | null) => void;
}

export interface ChatTUIOptions {
  initialMessage?: string | undefined;
  extraContext?: string | undefined;
  ctx: ExtensionContext;
}

/**
 * Open the chat TUI overlay.
 */
export async function createChatTUI(
  options: ChatTUIOptions,
  callbacks: ChatTUICallbacks,
): Promise<void> {
  const { ctx, initialMessage } = options;
  if (!ctx.hasUI) return;

  const engine = new ChatEngine(ctx, options.extraContext);

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      let inputBuffer = "";
      let scrollOffset = 0; // 0 = bottom (latest), higher = scrolled up
      let showExitMenu = false;
      let showModelPicker = false;
      let modelFilterText = "";
      let modelSelectedIndex = 0;
      let exitMenuIndex = 0;
      let abortController: AbortController | null = null;
      let streamingChunks = "";
      let processing = false; // blocks input during summarization
      let processingLabel = "";
      let cachedLines: string[] | undefined;

      // If initial message provided, send it immediately
      if (initialMessage) {
        sendMessage(initialMessage);
      }

      function invalidate() {
        cachedLines = undefined;
      }

      async function sendMessage(text: string) {
        if (!text.trim()) return;
        scrollOffset = 0; // auto-scroll to bottom on send
        abortController = new AbortController();
        streamingChunks = "";
        invalidate();
        _tui.requestRender();

        try {
          await engine.send(
            text,
            abortController.signal,
            (chunk) => {
              streamingChunks += chunk;
              scrollOffset = 0; // auto-scroll during streaming
              invalidate();
              _tui.requestRender();
            },
          );
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            streamingChunks = `Error: ${(err as Error).message}`;
          }
        } finally {
          streamingChunks = "";
          abortController = null;
          invalidate();
          _tui.requestRender();
        }
      }

      function handleInput(data: string) {
        // Block all input while processing
        if (processing) return;

        if (showModelPicker) {
          handleModelPickerInput(data);
          return;
        }
        if (showExitMenu) {
          handleExitMenuInput(data);
          return;
        }

        // Streaming: only Esc cancels
        if (engine.streaming) {
          if (matchesKey(data, Key.escape)) {
            abortController?.abort();
          }
          return;
        }

        // Escape: exit menu (or close if empty)
        if (matchesKey(data, Key.escape)) {
          if (engine.getMessages().length === 0) {
            callbacks.onExit(null);
            done(undefined);
            return;
          }
          showExitMenu = true;
          exitMenuIndex = 0;
          invalidate();
          _tui.requestRender();
          return;
        }

        // Enter: send message
        if (matchesKey(data, Key.enter)) {
          if (inputBuffer.trim()) {
            const msg = inputBuffer;
            inputBuffer = "";
            sendMessage(msg);
          }
          invalidate();
          _tui.requestRender();
          return;
        }

        // Ctrl+L: open model picker
        if (matchesKey(data, Key.ctrl("l"))) {
          showModelPicker = true;
          modelFilterText = "";
          modelSelectedIndex = 0;
          invalidate();
          _tui.requestRender();
          return;
        }

        // Shift+Up: scroll up (see older messages)
        if (matchesKey(data, Key.shift("up"))) {
          scrollOffset += 1;
          invalidate();
          _tui.requestRender();
          return;
        }
        // Shift+Down: scroll down (towards latest)
        if (matchesKey(data, Key.shift("down"))) {
          scrollOffset = Math.max(0, scrollOffset - 1);
          invalidate();
          _tui.requestRender();
          return;
        }
        // Ctrl+Up: scroll up fast
        if (matchesKey(data, Key.ctrl("up"))) {
          scrollOffset += 5;
          invalidate();
          _tui.requestRender();
          return;
        }
        // Ctrl+Down: scroll down fast
        if (matchesKey(data, Key.ctrl("down"))) {
          scrollOffset = Math.max(0, scrollOffset - 5);
          invalidate();
          _tui.requestRender();
          return;
        }

        // Text input
        if (matchesKey(data, Key.backspace)) {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          inputBuffer += data;
        }

        invalidate();
        _tui.requestRender();
      }

      function getFilteredModels() {
        const all = ctx.modelRegistry.getAll();
        if (!modelFilterText) return all;
        const lower = modelFilterText.toLowerCase();
        return all.filter((m) =>
          m.name.toLowerCase().includes(lower) ||
          m.id.toLowerCase().includes(lower) ||
          m.provider.toLowerCase().includes(lower)
        );
      }

      function handleModelPickerInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          showModelPicker = false;
          invalidate();
          _tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const filtered = getFilteredModels();
          const selected = filtered[modelSelectedIndex];
          if (selected) {
            engine.setModel(selected);
          }
          showModelPicker = false;
          invalidate();
          _tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.up) || (matchesKey(data, Key.ctrl("p")))) {
          modelSelectedIndex = Math.max(0, modelSelectedIndex - 1);
        } else if (matchesKey(data, Key.down) || (matchesKey(data, Key.ctrl("n")))) {
          const filtered = getFilteredModels();
          modelSelectedIndex = Math.min(filtered.length - 1, modelSelectedIndex + 1);
        } else if (matchesKey(data, Key.backspace)) {
          modelFilterText = modelFilterText.slice(0, -1);
          modelSelectedIndex = 0;
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          modelFilterText += data;
          modelSelectedIndex = 0;
        }

        invalidate();
        _tui.requestRender();
      }

      function runExitAction(action: typeof EXIT_ACTIONS[number]) {
        const needsProcessing = action.action === "summarize-inject" || action.action === "save-as-note";
        if (needsProcessing) {
          processing = true;
          processingLabel = action.action === "save-as-note" ? "Summarizing to note..." : "Summarizing...";
          invalidate();
          _tui.requestRender();
        }
        executeExitAction(action.action, engine)
          .then((result) => {
            processing = false;
            callbacks.onExit(result);
            done(undefined);
          })
          .catch(() => {
            processing = false;
            callbacks.onExit(null);
            done(undefined);
          });
      }

      function handleExitMenuInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          showExitMenu = false;
          invalidate();
          _tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.up) || data === "k") {
          exitMenuIndex = Math.max(0, exitMenuIndex - 1);
        } else if (matchesKey(data, Key.down) || data === "j") {
          exitMenuIndex = Math.min(EXIT_ACTIONS.length - 1, exitMenuIndex + 1);
        } else if (matchesKey(data, Key.enter)) {
          const action = EXIT_ACTIONS[exitMenuIndex]!;
          runExitAction(action);
          return;
        } else {
          // Shortcut keys
          for (const action of EXIT_ACTIONS) {
            if (data === action.key) {
              runExitAction(action);
              return;
            }
          }
        }

        invalidate();
        _tui.requestRender();
      }

      // Build chat content lines
      function buildChatLines(contentW: number): string[] {
        const chatLines: string[] = [];
        const messages = engine.getMessages();

        if (messages.length === 0 && !engine.streaming) {
          chatLines.push("");
          chatLines.push(theme.fg("dim", "  Type below to start a side conversation."));
          chatLines.push("");
          return chatLines;
        }

        chatLines.push("");

        for (const msg of messages) {
          if (msg.role === "user") {
            const userLines = msg.content.split("\n");
            chatLines.push("  " + theme.fg("accent", theme.bold("You: ")) + (userLines[0] ?? ""));
            for (const line of userLines.slice(1)) {
              for (const wrapped of wrapTextWithAnsi(line, contentW - 6)) {
                chatLines.push("       " + wrapped);
              }
            }
          } else {
            chatLines.push("  " + theme.fg("muted", theme.bold("AI: ")));
            for (const line of msg.content.split("\n")) {
              for (const wrapped of wrapTextWithAnsi(line, contentW - 4)) {
                chatLines.push("    " + wrapped);
              }
            }
          }
          chatLines.push("");
        }

        // Streaming
        if (engine.streaming) {
          if (streamingChunks) {
            chatLines.push("  " + theme.fg("muted", theme.bold("AI: ")));
            for (const line of streamingChunks.split("\n")) {
              for (const wrapped of wrapTextWithAnsi(line, contentW - 4)) {
                chatLines.push("    " + wrapped);
              }
            }
          } else {
            chatLines.push("  " + theme.fg("dim", "  Thinking..."));
          }
          chatLines.push("");
        }

        return chatLines;
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const contentW = width - 4;
        const lines: string[] = [];

        // -- Title bar with model name and usage --
        const modelObj = engine.model;
        const modelName = modelObj?.name ?? modelObj?.id ?? "default";
        const providerName = modelObj?.provider ?? "";
        const titleText = " Side Chat ";
        const modelText = ` ${providerName}/${modelName} `;

        // Usage stats
        const usage = engine.getUsage();
        let usageText = "";
        if (usage.turns > 0) {
          const ctxWindow = modelObj?.contextWindow ?? 200_000;
          const pct = ctxWindow > 0 ? Math.round((usage.contextTokens / ctxWindow) * 100) : 0;
          usageText = ` ${fmt(usage.contextTokens)}/${fmt(ctxWindow)} (${pct}%) $${usage.cost.toFixed(4)} `;
        }

        const fixedLen = visibleWidth(titleText) + visibleWidth(modelText) + visibleWidth(usageText);
        const availDashes = Math.max(4, width - 2 - fixedLen);
        const dashLeft = 1;
        const dashRight = Math.max(1, availDashes - dashLeft);

        lines.push(
          theme.fg("accent", "\u256d" + "\u2500".repeat(dashLeft)) +
          theme.fg("accent", theme.bold(titleText)) +
          theme.fg("muted", modelText) +
          (usageText ? theme.fg("dim", usageText) : "") +
          theme.fg("accent", "\u2500".repeat(dashRight) + "\u256e"),
        );

        if (processing) {
          // Processing indicator
          lines.push(padRow("", contentW, theme));
          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.fg("accent", "  \u23f3 " + processingLabel), contentW, theme));
          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.fg("dim", "  Please wait..."), contentW, theme));
          lines.push(padRow("", contentW, theme));
        } else if (showModelPicker) {
          // Model picker
          const filtered = getFilteredModels();
          const currentModel = engine.model;
          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.bold("  Select model:"), contentW, theme));
          lines.push(padRow("", contentW, theme));

          // Search input
          const searchLine = "  " + theme.fg("dim", "search: ") + modelFilterText + "\u2588";
          lines.push(padRow(searchLine, contentW, theme));
          lines.push(padRow("", contentW, theme));

          // Model list (show up to 10)
          const maxVisible = 10;
          const startIdx2 = Math.max(0, modelSelectedIndex - Math.floor(maxVisible / 2));
          const endIdx2 = Math.min(filtered.length, startIdx2 + maxVisible);

          for (let i = startIdx2; i < endIdx2; i++) {
            const m = filtered[i]!;
            const isSelected = i === modelSelectedIndex;
            const isCurrent = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
            const cursor = isSelected ? theme.fg("accent", "\u25b8 ") : "  ";
            const name = `${m.provider}/${m.name}`;
            const marker = isCurrent ? theme.fg("success", " \u2713") : "";
            const styled = isSelected ? theme.fg("accent", name) : name;
            lines.push(padRow(`  ${cursor}${styled}${marker}`, contentW, theme));
          }

          if (filtered.length === 0) {
            lines.push(padRow(theme.fg("dim", "  No models match filter"), contentW, theme));
          }

          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.fg("dim", "  type to filter | Enter select | Esc cancel"), contentW, theme));
        } else if (showExitMenu) {
          // Exit menu
          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.bold("  Close side-chat:"), contentW, theme));
          lines.push(padRow("", contentW, theme));

          for (let i = 0; i < EXIT_ACTIONS.length; i++) {
            const action = EXIT_ACTIONS[i]!;
            const selected = i === exitMenuIndex;
            const cursor = selected ? theme.fg("accent", " \u25b8 ") : "   ";
            const key = theme.fg("dim", `[${action.key}]`);
            const label = selected ? theme.fg("accent", action.label) : action.label;
            const desc = theme.fg("dim", ` ${action.description}`);
            lines.push(padRow(`${cursor}${key} ${label}${desc}`, contentW, theme));
          }

          lines.push(padRow("", contentW, theme));
          lines.push(padRow(theme.fg("dim", "  Enter select · Esc back"), contentW, theme));
        } else {
          // Chat area with proper scrolling
          const allChatLines = buildChatLines(contentW);

          // Calculate available chat height
          const chromeLines = 5; // title + separator + input + hints + bottom border
          const maxChatHeight = Math.max(5, 20 - chromeLines);

          // Clamp scroll offset
          const maxScroll = Math.max(0, allChatLines.length - maxChatHeight);
          scrollOffset = Math.min(scrollOffset, maxScroll);

          // Auto-scroll to bottom during streaming
          if (engine.streaming) {
            scrollOffset = 0;
          }

          // Calculate visible slice (scrollOffset=0 means show bottom/latest)
          let visibleChatLines: string[];
          if (allChatLines.length <= maxChatHeight) {
            visibleChatLines = allChatLines;
          } else {
            const end = allChatLines.length - scrollOffset;
            const start = Math.max(0, end - maxChatHeight);
            visibleChatLines = allChatLines.slice(start, end);
          }

          // Scroll indicators
          const hasMoreAbove = allChatLines.length > maxChatHeight &&
            (allChatLines.length - scrollOffset - maxChatHeight) > 0;
          const hasMoreBelow = scrollOffset > 0;

          if (hasMoreAbove) {
            const count = allChatLines.length - scrollOffset - maxChatHeight;
            lines.push(padRow(theme.fg("dim", `  \u25b2 ${count} more above`), contentW, theme));
          }

          for (const cl of visibleChatLines) {
            lines.push(padRow(cl, contentW, theme));
          }

          if (hasMoreBelow) {
            lines.push(padRow(theme.fg("dim", `  \u25bc ${scrollOffset} more below`), contentW, theme));
          }

          // Pad remaining space
          const usedChat = visibleChatLines.length + (hasMoreAbove ? 1 : 0) + (hasMoreBelow ? 1 : 0);
          const pad2 = Math.max(0, maxChatHeight - usedChat);
          for (let i = 0; i < pad2; i++) {
            lines.push(padRow("", contentW, theme));
          }

          // Input separator
          lines.push(
            theme.fg("accent", "\u251c") +
            theme.fg("dim", "\u2500".repeat(width - 2)) +
            theme.fg("accent", "\u2524"),
          );

          // Input area
          const promptIcon = theme.fg("accent", "\u25b8 ");
          const cursor = engine.streaming ? "" : "\u2588";
          lines.push(padRow(promptIcon + inputBuffer + cursor, contentW, theme));

          // Hints
          const hints = engine.streaming
            ? "Esc cancel"
            : "Enter send | Esc close | S-\u2191\u2193 scroll | C-\u2191\u2193 fast | Ctrl+L model";
          lines.push(padRow(theme.fg("dim", "  " + hints), contentW, theme));
        }

        // Bottom border
        lines.push(theme.fg("accent", "\u2570" + "\u2500".repeat(width - 2) + "\u256f"));

        cachedLines = lines;
        return lines;
      }

      return { render, invalidate, handleInput };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as unknown as "center",
        width: "70%",
        minWidth: 50,
        maxHeight: "80%",
      },
    },
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function pad(s: string, len: number): string {
  const vis = visibleWidth(s);
  return s + " ".repeat(Math.max(0, len - vis));
}

function padRow(content: string, innerW: number, theme: Theme): string {
  const fitted = visibleWidth(content) > innerW
    ? truncateToWidth(content, innerW)
    : pad(content, innerW);
  return theme.fg("accent", "\u2502") + " " + fitted + " " + theme.fg("accent", "\u2502");
}
