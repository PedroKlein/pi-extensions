import { describe, it, expect } from "vitest";
import { NotesStore } from "../../src/notes/store.js";
import { createNote } from "../../src/notes/model.js";
import type { AdhDConfig } from "../../src/config.js";

// Minimal mock for testing tracker logic
function createMockCtx(notifications: string[] = []) {
  return {
    hasUI: true,
    ui: {
      notify: (msg: string) => notifications.push(msg),
      setStatus: (_id: string, _status: string | undefined) => {},
    },
  };
}

// Import the functions directly
import { onTurnEnd, updateStatus } from "../../src/reminders/tracker.js";

describe("tracker", () => {
  const config: AdhDConfig = { reminderTurns: 3, chatTools: true };

  it("does nothing when store is empty", () => {
    const store = new NotesStore();
    const notifications: string[] = [];
    const ctx = createMockCtx(notifications);
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onTurnEnd(store, config, ctx as any);
    }
    expect(notifications).toHaveLength(0);
  });

  it("fires notification after threshold turns", () => {
    const store = new NotesStore();
    store.add(createNote("X", "y", "prompt"));
    const notifications: string[] = [];
    const ctx = createMockCtx(notifications);
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onTurnEnd(store, config, ctx as any);
    }
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("1 pending notes");
  });

  it("does not fire again until reset", () => {
    const store = new NotesStore();
    store.add(createNote("X", "y", "prompt"));
    const notifications: string[] = [];
    const ctx = createMockCtx(notifications);
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onTurnEnd(store, config, ctx as any);
    }
    expect(notifications).toHaveLength(1);
  });

  describe("updateStatus", () => {
    it("clears status when no notes", () => {
      const store = new NotesStore();
      let statusValue: string | undefined = "old";
      const ctx = {
        hasUI: true,
        ui: {
          setStatus: (_id: string, val: string | undefined) => { statusValue = val; },
          notify: () => {},
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateStatus(store, ctx as any);
      expect(statusValue).toBeUndefined();
    });

    it("shows count when notes exist", () => {
      const store = new NotesStore();
      store.add(createNote("X", "y", "prompt"));
      let statusValue = "";
      const ctx = {
        hasUI: true,
        ui: {
          setStatus: (_id: string, val: string | undefined) => { statusValue = val ?? ""; },
          notify: () => {},
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateStatus(store, ctx as any);
      expect(statusValue).toContain("1 notes");
    });
  });
});
