/**
 * Note preview/edit form overlay.
 * Shows classified note fields for user confirmation before saving.
 * Reused by /note capture and btw "save as note" exit action.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Note, NoteCategory } from "./model.js";
import { createNote, CATEGORIES, CATEGORY_ICONS } from "./model.js";
import type { ClassifiedNote } from "./capture.js";

export interface NoteFormResult {
  note: Note;
}

/**
 * Show the note preview form overlay.
 * Returns the confirmed Note, or null if cancelled.
 */
export async function showNoteForm(
  ctx: ExtensionContext,
  classified: ClassifiedNote,
): Promise<Note | null> {
  if (!ctx.hasUI) return null;

  return ctx.ui.custom<Note | null>(
    (_tui, theme, _kb, done) => {
      const fields = {
        title: classified.title,
        category: classified.category as NoteCategory,
        content: classified.content,
      };

      type FieldKey = "title" | "category" | "content";
      const FIELDS: FieldKey[] = ["title", "category", "content"];
      const ACTIONS = ["save", "discard"] as const;
      type FocusArea = "fields" | "actions";

      let fieldIndex = 0;
      let actionIndex = 0;
      let focusArea: FocusArea = "fields";
      let editing = false;
      let editBuffer = "";
      let cachedLines: string[] | undefined;

      function invalidate() {
        cachedLines = undefined;
      }

      function handleInput(data: string) {
        if (editing) {
          handleEditInput(data);
        } else {
          handleNavInput(data);
        }
        invalidate();
        _tui.requestRender();
      }

      function handleNavInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") {
          done(null);
          return;
        }

        if (matchesKey(data, Key.up) || data === "k") {
          if (focusArea === "actions") {
            focusArea = "fields";
            fieldIndex = FIELDS.length - 1;
          } else if (fieldIndex > 0) {
            fieldIndex--;
          }
        } else if (matchesKey(data, Key.down) || data === "j") {
          if (focusArea === "fields") {
            if (fieldIndex < FIELDS.length - 1) {
              fieldIndex++;
            } else {
              focusArea = "actions";
              actionIndex = 0;
            }
          }
        } else if (matchesKey(data, Key.left) || data === "h") {
          if (focusArea === "actions" && actionIndex > 0) actionIndex--;
        } else if (matchesKey(data, Key.right) || data === "l") {
          if (focusArea === "actions" && actionIndex < ACTIONS.length - 1) actionIndex++;
        } else if (matchesKey(data, Key.tab)) {
          if (focusArea === "fields") {
            focusArea = "actions";
            actionIndex = 0;
          } else {
            focusArea = "fields";
            fieldIndex = 0;
          }
        } else if (matchesKey(data, Key.enter)) {
          if (focusArea === "actions") {
            if (ACTIONS[actionIndex] === "save") {
              done(createNote(fields.title, fields.content, fields.category));
            } else {
              done(null);
            }
          } else {
            const field = FIELDS[fieldIndex]!;
            if (field === "category") {
              const idx = CATEGORIES.indexOf(fields.category);
              fields.category = CATEGORIES[(idx + 1) % CATEGORIES.length]!;
            } else {
              editing = true;
              editBuffer = fields[field];
            }
          }
        }
      }

      function handleEditInput(data: string) {
        if (matchesKey(data, Key.enter)) {
          const field = FIELDS[fieldIndex]!;
          if (field !== "category") {
            fields[field] = editBuffer.trim() || fields[field];
          }
          editing = false;
        } else if (matchesKey(data, Key.escape)) {
          editing = false;
        } else if (matchesKey(data, Key.backspace)) {
          editBuffer = editBuffer.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          editBuffer += data;
        }
      }

      function pad(s: string, len: number): string {
        const vis = visibleWidth(s);
        return s + " ".repeat(Math.max(0, len - vis));
      }

      function row(content: string, contentW: number): string {
        const fitted =
          visibleWidth(content) > contentW
            ? truncateToWidth(content, contentW)
            : pad(content, contentW);
        return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
      }

      function emptyRow(contentW: number): string {
        return row("", contentW);
      }

      function fieldLabel(field: FieldKey): string {
        switch (field) {
          case "title": return "Title";
          case "category": return "Category";
          case "content": return "Content";
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const contentW = width - 4;
        const lines: string[] = [];

        // Top border
        const titleText = " 🗒️  New Note ";
        const titleLen = visibleWidth(titleText);
        const leftDash = 1;
        const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
        lines.push(
          theme.fg("accent", "╭" + "─".repeat(leftDash)) +
            theme.fg("accent", theme.bold(titleText)) +
            theme.fg("accent", "─".repeat(rightDash) + "╮"),
        );

        lines.push(emptyRow(contentW));

        // Fields
        for (let i = 0; i < FIELDS.length; i++) {
          const field = FIELDS[i]!;
          const selected = focusArea === "fields" && i === fieldIndex;
          const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
          const label = theme.fg("muted", padRight(fieldLabel(field) + ":", 12));

          let value: string;
          if (editing && selected) {
            value = theme.fg("accent", editBuffer + "█");
          } else if (field === "category") {
            const icon = CATEGORY_ICONS[fields.category];
            value = `${icon} ${fields.category}`;
          } else if (field === "content" && fields.content.length > contentW - 20) {
            value = fields.content.slice(0, contentW - 25) + "...";
          } else {
            value = fields[field] || theme.fg("dim", "(none)");
          }

          let hint = "";
          if (!editing && selected) {
            if (field === "category") hint = theme.fg("dim", " (Enter to cycle)");
            else hint = theme.fg("dim", " (Enter to edit)");
          }

          lines.push(row(prefix + label + value + hint, contentW));
        }

        lines.push(emptyRow(contentW));

        // Actions
        let actionLine = "    ";
        for (let i = 0; i < ACTIONS.length; i++) {
          const label = ACTIONS[i]!.charAt(0).toUpperCase() + ACTIONS[i]!.slice(1);
          const selected = focusArea === "actions" && i === actionIndex;
          if (i > 0) actionLine += "     ";
          if (selected) {
            actionLine += theme.fg("accent", theme.bold(`[ ${label} ]`));
          } else {
            actionLine += theme.fg("muted", `  ${label}  `);
          }
        }
        lines.push(row(actionLine, contentW));

        lines.push(emptyRow(contentW));

        // Footer hints
        const hints = editing
          ? "Enter save · Esc cancel"
          : "↑↓ navigate · Enter select · Tab actions · Esc close";
        lines.push(row(theme.fg("dim", "  " + hints), contentW));

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
        width: "60%",
        minWidth: 45,
        maxHeight: "50%",
      },
    },
  );
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}
