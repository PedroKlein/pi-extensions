/**
 * In-memory note store with reminder tracking.
 * Session-scoped — all data lost on session end unless pinned.
 */

import type { Note, InjectionResult, PinScope } from "./model.js";
import { CATEGORY_INJECTION_MODE } from "./model.js";

export class NotesStore {
  private notes: Note[] = [];
  private _turnsSinceInteraction = 0;
  private _reminderFired = false;

  /** Add a note to the store */
  add(note: Note): void {
    this.notes.push(note);
  }

  /** Remove a note by ID */
  remove(id: string): void {
    this.notes = this.notes.filter((n) => n.id !== id);
  }

  /** Update a note's fields */
  update(id: string, patch: Partial<Pick<Note, "title" | "content" | "category" | "pinned">>): void {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return;
    if (patch.title !== undefined) note.title = patch.title;
    if (patch.content !== undefined) note.content = patch.content;
    if (patch.category !== undefined) note.category = patch.category;
    if (patch.pinned !== undefined) note.pinned = patch.pinned;
  }

  /** Get a single note by ID */
  get(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  /** Get all notes */
  getAll(): Note[] {
    return [...this.notes];
  }

  /** Get only pinned notes for a given scope */
  getPinned(scope: PinScope): Note[] {
    return this.notes.filter((n) => n.pinned === scope);
  }

  /** Get orphan notes (not pinned, not injected — still in store) */
  getOrphans(): Note[] {
    return this.notes.filter((n) => n.pinned === null);
  }

  /**
   * Inject a note: removes it from store and returns injection info.
   * Throws if category is "reminder" (reminders cannot be injected).
   */
  inject(id: string): InjectionResult {
    const note = this.notes.find((n) => n.id === id);
    if (!note) throw new Error(`Note ${id} not found`);

    const mode = CATEGORY_INJECTION_MODE[note.category];
    if (mode === null) {
      throw new Error(`Cannot inject a ${note.category} note — reminders are for your eyes only`);
    }

    this.remove(id);
    return { content: note.content, mode };
  }

  /** Increment turn counter (called on each agent turn_end) */
  incrementTurns(): void {
    this._turnsSinceInteraction++;
  }

  /** Check if reminder should fire */
  shouldRemind(threshold: number): boolean {
    if (this.notes.length === 0) return false;
    return this._turnsSinceInteraction >= threshold && !this._reminderFired;
  }

  /** Mark reminder as fired (prevents repeated firing until reset) */
  markReminderFired(): void {
    this._reminderFired = true;
  }

  /** Reset reminder counter (called when user opens TUI) */
  resetReminderCounter(): void {
    this._turnsSinceInteraction = 0;
    this._reminderFired = false;
  }

  /** Load pinned notes from persistence into the store */
  loadPinned(notes: Note[]): void {
    for (const note of notes) {
      // Avoid duplicates by ID
      if (!this.notes.some((n) => n.id === note.id)) {
        this.notes.push(note);
      }
    }
  }

  /** Total note count */
  get count(): number {
    return this.notes.length;
  }

  /** Turns since last interaction */
  get turnsSinceInteraction(): number {
    return this._turnsSinceInteraction;
  }

  /** Whether reminder has been fired */
  get reminderFired(): boolean {
    return this._reminderFired;
  }
}
