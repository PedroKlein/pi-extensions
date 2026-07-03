/**
 * Session-end orphan overlay — best-effort last-chance to pin notes.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Note, PinScope } from "../notes/model.js";
import { CATEGORY_ICONS } from "../notes/model.js";
import type { NotesStore } from "../notes/store.js";

export interface ShutdownCallbacks {
  onPin: (note: Note, scope: PinScope) => void;
}

/**
 * Show the shutdown overlay listing orphan notes.
 * Best-effort: runs during session_shutdown. May not complete if Pi exits.
 */
export async function createShutdownOverlay(
  ctx: ExtensionContext,
  store: NotesStore,
  callbacks: ShutdownCallbacks,
): Promise<void> {
  if (!ctx.hasUI) return;

  const orphans = store.getOrphans();
  if (orphans.length === 0) return;

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      let selectedIndex = 0;
      let cachedLines: string[] | undefined;
      // Track which notes have been handled
      const handled = new Set<string>();

      function getRemaining(): Note[] {
        return orphans.filter((n) => !handled.has(n.id));
      }

      function invalidate() {
        cachedLines = undefined;
      }

      function handleInput(data: string) {
        const remaining = getRemaining();

        // Dismiss all
        if (matchesKey(data, Key.escape) || data === "q") {
          done(undefined);
          return;
        }

        if (remaining.length === 0) {
          done(undefined);
          return;
        }

        // Navigation
        if (matchesKey(data, Key.up) || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
        } else if (matchesKey(data, Key.down) || data === "j") {
          selectedIndex = Math.min(remaining.length - 1, selectedIndex + 1);
        }

        // Pin project
        else if (data === "p") {
          const note = remaining[selectedIndex];
          if (note) {
            callbacks.onPin(note, "project");
            handled.add(note.id);
            selectedIndex = Math.min(selectedIndex, Math.max(0, getRemaining().length - 1));
            if (getRemaining().length === 0) {
              done(undefined);
              return;
            }
          }
        }
        // Pin global
        else if (data === "P") {
          const note = remaining[selectedIndex];
          if (note) {
            callbacks.onPin(note, "global");
            handled.add(note.id);
            selectedIndex = Math.min(selectedIndex, Math.max(0, getRemaining().length - 1));
            if (getRemaining().length === 0) {
              done(undefined);
              return;
            }
          }
        }
        // Dismiss single
        else if (data === "d" || matchesKey(data, Key.enter)) {
          const note = remaining[selectedIndex];
          if (note) {
            handled.add(note.id);
            selectedIndex = Math.min(selectedIndex, Math.max(0, getRemaining().length - 1));
            if (getRemaining().length === 0) {
              done(undefined);
              return;
            }
          }
        }

        invalidate();
        _tui.requestRender();
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const remaining = getRemaining();
        const innerW = width - 4;
        const lines: string[] = [];

        // Top border
        const titleText = ` ⚠️  ${remaining.length} orphan note${remaining.length > 1 ? "s" : ""} `;
        const titleLen = visibleWidth(titleText);
        const leftDash = 1;
        const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
        lines.push(
          theme.fg("warning", "╭" + "─".repeat(leftDash)) +
            theme.fg("warning", theme.bold(titleText)) +
            theme.fg("warning", "─".repeat(rightDash) + "╮"),
        );

        lines.push(padRow(theme.fg("dim", "  These notes will be lost. Pin them to keep for next session:"), innerW, theme));
        lines.push(padRow("", innerW, theme));

        for (let i = 0; i < remaining.length; i++) {
          const note = remaining[i]!;
          const isSelected = i === selectedIndex;
          const cursor = isSelected ? theme.fg("accent", "▸") : " ";
          const icon = CATEGORY_ICONS[note.category];
          const title = note.title.length > innerW - 10
            ? note.title.slice(0, innerW - 13) + "..."
            : note.title;
          const styledTitle = isSelected ? theme.fg("accent", title) : title;
          lines.push(padRow(`  ${cursor} ${icon} ${styledTitle}`, innerW, theme));
        }

        lines.push(padRow("", innerW, theme));
        lines.push(padRow(theme.fg("dim", "  p pin project · P pin global · d dismiss · q dismiss all"), innerW, theme));

        // Bottom border
        lines.push(theme.fg("warning", "╰" + "─".repeat(width - 2) + "╯"));

        cachedLines = lines;
        return lines;
      }

      return { render, invalidate, handleInput };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as unknown as "center",
        width: "60%",
        minWidth: 45,
        maxHeight: "50%",
      },
    },
  );
}

function pad(s: string, len: number): string {
  const vis = visibleWidth(s);
  return s + " ".repeat(Math.max(0, len - vis));
}

function padRow(content: string, innerW: number, theme: Theme): string {
  const fitted = visibleWidth(content) > innerW
    ? truncateToWidth(content, innerW)
    : pad(content, innerW);
  return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
}
