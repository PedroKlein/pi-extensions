/**
 * Pin orchestration — the one place that decides what a pin keypress means.
 *
 * The notes TUI and the session-end overlay both pin notes, and they had
 * already drifted apart once: the overlay never cleared a previous scope, so
 * re-pinning could leave the same note in two files. Both call sites now go
 * through `applyPin()`.
 */

import type { PinScope } from "./model.js";
import { removePinned, savePinned } from "./persistence.js";
import type { NotesStore } from "./store.js";

/**
 * Pressing the scope a note is already pinned to unpins it, so `p` / `P`
 * behave as toggles instead of one-way doors.
 */
export function nextPinScope(current: PinScope | null, requested: PinScope): PinScope | null {
  return current === requested ? null : requested;
}

/**
 * Apply a pin keypress: update the store, keep the project and global files
 * mutually exclusive, and return the resulting scope (`null` = unpinned).
 *
 * Returns `null` without touching anything when the note is gone.
 */
export function applyPin(
  store: NotesStore,
  noteId: string,
  requested: PinScope,
  repoSlug: string,
): PinScope | null {
  const note = store.get(noteId);
  if (!note) return null;

  const next = nextPinScope(note.pinned, requested);

  // Drop the previous scope first. Otherwise the note stays in both files and
  // only looks correct because loadPinned() dedupes by id.
  if (note.pinned) {
    removePinned(noteId, note.pinned, repoSlug);
  }

  store.update(noteId, { pinned: next });

  if (next !== null) {
    const updated = store.get(noteId);
    if (updated) {
      savePinned(updated, next, repoSlug);
    }
  }

  return next;
}
