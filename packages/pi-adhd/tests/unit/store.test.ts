import { describe, it, expect, beforeEach } from "vitest";
import { NotesStore } from "../../src/notes/store.js";
import { createNote } from "../../src/notes/model.js";

describe("NotesStore", () => {
  let store: NotesStore;

  beforeEach(() => {
    store = new NotesStore();
  });

  describe("CRUD", () => {
    it("adds a note", () => {
      const note = createNote("Test", "content", "prompt");
      store.add(note);
      expect(store.count).toBe(1);
      expect(store.getAll()[0]?.title).toBe("Test");
    });

    it("removes a note by id", () => {
      const note = createNote("Test", "content", "prompt");
      store.add(note);
      store.remove(note.id);
      expect(store.count).toBe(0);
    });

    it("updates a note's fields", () => {
      const note = createNote("Test", "content", "prompt");
      store.add(note);
      store.update(note.id, { title: "Updated", category: "reminder" });
      const updated = store.get(note.id);
      expect(updated?.title).toBe("Updated");
      expect(updated?.category).toBe("reminder");
    });

    it("get returns undefined for unknown id", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("getAll returns copies", () => {
      const note = createNote("Test", "content", "prompt");
      store.add(note);
      const all = store.getAll();
      all.pop();
      expect(store.count).toBe(1);
    });
  });

  describe("injection", () => {
    it("injects a prompt note and removes it", () => {
      const note = createNote("Test", "do this", "prompt");
      store.add(note);
      const result = store.inject(note.id);
      expect(result.mode).toBe("prompt");
      expect(result.content).toBe("do this");
      expect(store.count).toBe(0);
    });

    it("injects a reference note as context", () => {
      const note = createNote("Ref", "some info", "reference");
      store.add(note);
      const result = store.inject(note.id);
      expect(result.mode).toBe("context");
      expect(result.content).toBe("some info");
    });

    it("throws on injecting a reminder note", () => {
      const note = createNote("Remind", "check CI", "reminder");
      store.add(note);
      expect(() => store.inject(note.id)).toThrow("Cannot inject");
    });

    it("throws on injecting non-existent note", () => {
      expect(() => store.inject("fake")).toThrow("not found");
    });
  });

  describe("reminder logic", () => {
    it("shouldRemind is false when no notes", () => {
      for (let i = 0; i < 10; i++) store.incrementTurns();
      expect(store.shouldRemind(8)).toBe(false);
    });

    it("shouldRemind fires after threshold turns", () => {
      store.add(createNote("X", "y", "prompt"));
      for (let i = 0; i < 8; i++) store.incrementTurns();
      expect(store.shouldRemind(8)).toBe(true);
    });

    it("shouldRemind does not fire below threshold", () => {
      store.add(createNote("X", "y", "prompt"));
      for (let i = 0; i < 7; i++) store.incrementTurns();
      expect(store.shouldRemind(8)).toBe(false);
    });

    it("markReminderFired prevents re-firing", () => {
      store.add(createNote("X", "y", "prompt"));
      for (let i = 0; i < 8; i++) store.incrementTurns();
      store.markReminderFired();
      expect(store.shouldRemind(8)).toBe(false);
    });

    it("resetReminderCounter resets everything", () => {
      store.add(createNote("X", "y", "prompt"));
      for (let i = 0; i < 10; i++) store.incrementTurns();
      store.markReminderFired();
      store.resetReminderCounter();
      expect(store.turnsSinceInteraction).toBe(0);
      expect(store.reminderFired).toBe(false);
    });
  });

  describe("pinned notes", () => {
    it("loadPinned merges without duplicates", () => {
      const note = createNote("Pinned", "content", "prompt");
      note.pinned = "project";
      store.loadPinned([note]);
      store.loadPinned([note]); // duplicate
      expect(store.count).toBe(1);
    });

    it("getOrphans returns unpinned notes", () => {
      const orphan = createNote("Orphan", "x", "prompt");
      const pinned = createNote("Pinned", "y", "prompt");
      pinned.pinned = "project";
      store.add(orphan);
      store.add(pinned);
      const orphans = store.getOrphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.id).toBe(orphan.id);
    });
  });
});
