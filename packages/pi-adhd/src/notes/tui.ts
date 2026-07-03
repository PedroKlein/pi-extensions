/**
 * Two-column Notes TUI overlay.
 * Left: note list with icons. Right: preview of selected note.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Note, PinScope } from "./model.js";
import { CATEGORY_ICONS } from "./model.js";
import type { NotesStore } from "./store.js";

export interface NotesTUICallbacks {
  onInject: (note: Note) => void;
  onDelete: (note: Note) => void;
  onPin: (note: Note, scope: PinScope) => void;
  onEdit: (note: Note) => void;
  onCycleCategory: (note: Note) => void;
  onStatusUpdate: () => void;
}

/**
 * Open the notes TUI overlay.
 * Returns when user closes it (Esc/q).
 */
export async function createNotesTUI(
  ctx: ExtensionContext,
  store: NotesStore,
  callbacks: NotesTUICallbacks,
): Promise<void> {
  if (!ctx.hasUI) return;

  // Reset reminder counter — user is acknowledging notes
  store.resetReminderCounter();
  callbacks.onStatusUpdate();

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      let selectedIndex = 0;
      let cachedLines: string[] | undefined;

      function getNotes(): Note[] {
        return store.getAll();
      }

      function invalidate() {
        cachedLines = undefined;
      }

      function handleInput(data: string) {
        const notes = getNotes();

        if (matchesKey(data, Key.escape) || data === "q") {
          done(undefined);
          return;
        }

        if (notes.length === 0) {
          done(undefined);
          return;
        }

        // Navigation
        if (matchesKey(data, Key.up) || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
        } else if (matchesKey(data, Key.down) || data === "j") {
          selectedIndex = Math.min(notes.length - 1, selectedIndex + 1);
        }

        // Actions
        else if (matchesKey(data, Key.enter)) {
          const note = notes[selectedIndex];
          if (note && note.category !== "reminder") {
            callbacks.onInject(note);
            selectedIndex = Math.min(selectedIndex, Math.max(0, notes.length - 2));
            callbacks.onStatusUpdate();
            if (getNotes().length === 0) {
              done(undefined);
              return;
            }
          }
        } else if (data === "d") {
          const note = notes[selectedIndex];
          if (note) {
            callbacks.onDelete(note);
            selectedIndex = Math.min(selectedIndex, Math.max(0, notes.length - 2));
            callbacks.onStatusUpdate();
            if (getNotes().length === 0) {
              done(undefined);
              return;
            }
          }
        } else if (data === "p") {
          const note = notes[selectedIndex];
          if (note) {
            callbacks.onPin(note, "project");
            callbacks.onStatusUpdate();
          }
        } else if (data === "P") {
          const note = notes[selectedIndex];
          if (note) {
            callbacks.onPin(note, "global");
            callbacks.onStatusUpdate();
          }
        } else if (data === "c") {
          const note = notes[selectedIndex];
          if (note) {
            callbacks.onCycleCategory(note);
          }
        } else if (data === "e") {
          const note = notes[selectedIndex];
          if (note) {
            callbacks.onEdit(note);
            done(undefined); // Close TUI for edit
            return;
          }
        }

        invalidate();
        _tui.requestRender();
      }

      function wordWrap(text: string, maxWidth: number): string[] {
        if (maxWidth <= 0) return [text];
        const words = text.split(" ");
        const lines: string[] = [];
        let line = "";
        for (const word of words) {
          if (line.length + word.length + 1 > maxWidth && line.length > 0) {
            lines.push(line);
            line = "";
          }
          line += (line.length > 0 ? " " : "") + word;
        }
        if (line.length > 0) lines.push(line);
        return lines.length > 0 ? lines : [""];
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const notes = getNotes();
        const innerW = width - 4;
        const listW = Math.min(Math.floor(innerW * 0.4), 35);
        const previewW = innerW - listW - 3; // 3 for separator
        const lines: string[] = [];

        // Top border
        const titleText = ` 🧠 Notes (${notes.length}) `;
        const titleLen = visibleWidth(titleText);
        const leftDash = 1;
        const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
        lines.push(
          theme.fg("accent", "╭" + "─".repeat(leftDash)) +
            theme.fg("accent", theme.bold(titleText)) +
            theme.fg("accent", "─".repeat(rightDash) + "╮"),
        );

        if (notes.length === 0) {
          const emptyMsg = theme.fg("dim", "No notes. Use /note <text> to add one.");
          lines.push(padRow(emptyMsg, innerW, theme));
          lines.push(padRow("", innerW, theme));
        } else {
          // Header
          const listHeader = theme.fg("muted", pad("Notes", listW));
          const previewHeader = theme.fg("muted", "Preview");
          lines.push(
            theme.fg("accent", "│") + " " +
            listHeader + " " +
            theme.fg("dim", "│") + " " +
            pad(previewHeader, previewW) + " " +
            theme.fg("accent", "│"),
          );

          // Separator
          lines.push(
            theme.fg("accent", "│") +
            theme.fg("dim", "─".repeat(listW + 2) + "┼" + "─".repeat(previewW + 2)) +
            theme.fg("accent", "│"),
          );

          // Selected note for preview
          const selectedNote = notes[selectedIndex];
          const previewLines = selectedNote
            ? wordWrap(selectedNote.content, previewW)
            : [""];

          // Rows
          const maxRows = Math.max(notes.length, previewLines.length, 5);
          for (let i = 0; i < maxRows; i++) {
            // Left: note list
            let leftCell = "";
            if (i < notes.length) {
              const note = notes[i]!;
              const isSelected = i === selectedIndex;
              const cursor = isSelected ? theme.fg("accent", "▸") : " ";
              const pin = note.pinned ? "📌" : " ";
              const icon = CATEGORY_ICONS[note.category];
              const titleMaxW = listW - 8; // cursor + pin + icon + spaces
              const title = note.title.length > titleMaxW
                ? note.title.slice(0, titleMaxW - 1) + "…"
                : note.title;
              const styledTitle = isSelected ? theme.fg("accent", title) : title;
              leftCell = `${cursor} ${pin}${icon} ${styledTitle}`;
            }

            // Right: preview
            let rightCell = "";
            if (i < previewLines.length) {
              rightCell = previewLines[i] ?? "";
            }

            const leftPadded = pad(leftCell, listW);
            const rightPadded = pad(rightCell, previewW);

            lines.push(
              theme.fg("accent", "│") + " " +
              (visibleWidth(leftPadded) > listW ? truncateToWidth(leftPadded, listW) : leftPadded) + " " +
              theme.fg("dim", "│") + " " +
              (visibleWidth(rightPadded) > previewW ? truncateToWidth(rightPadded, previewW) : rightPadded) + " " +
              theme.fg("accent", "│"),
            );
          }
        }

        // Separator before hints
        lines.push(
          theme.fg("accent", "├") +
          theme.fg("dim", "─".repeat(width - 2)) +
          theme.fg("accent", "┤"),
        );

        // Hints
        const hints = "j/k nav · Enter inject · e edit · c category · d del · p pin · P global · q close";
        lines.push(padRow(theme.fg("dim", hints), innerW, theme));

        // Bottom border
        lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

        cachedLines = lines;
        return lines;
      }

      return { render, invalidate, handleInput };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as unknown as "center",
        width: "80%",
        minWidth: 60,
        maxHeight: "70%",
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
