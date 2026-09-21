import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotesStore } from "../../src/notes/store.js";
import type { Note, PinScope } from "../../src/notes/model.js";

// persistence.ts captures `join(homedir(), ".pi", "adhd")` when the module is
// evaluated, so HOME has to be redirected *before* it is imported. Resetting
// the module registry in beforeAll gives those modules a fresh evaluation
// under the temp HOME instead of the developer's real ~/.pi/adhd.
const home = mkdtempSync(join(tmpdir(), "pi-adhd-pin-test-"));

/** `global.json` is shared by every repo, so isolating by slug is not enough. */
const SLUG = "test-org-repo";

let NotesStore: typeof import("../../src/notes/store.js").NotesStore;
let createNote: typeof import("../../src/notes/model.js").createNote;
let applyPin: typeof import("../../src/notes/pin.js").applyPin;
let nextPinScope: typeof import("../../src/notes/pin.js").nextPinScope;
let loadPinned: typeof import("../../src/notes/persistence.js").loadPinned;

beforeAll(async () => {
  vi.stubEnv("HOME", home);
  vi.resetModules();

  NotesStore = (await import("../../src/notes/store.js")).NotesStore;
  createNote = (await import("../../src/notes/model.js")).createNote;
  ({ applyPin, nextPinScope } = await import("../../src/notes/pin.js"));
  loadPinned = (await import("../../src/notes/persistence.js")).loadPinned;
});

beforeEach(() => {
  // Wipe between tests: global.json is not namespaced by repo, so leftover rows
  // from an earlier test would otherwise show up in later counts.
  rmSync(join(home, ".pi"), { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Rows actually written to disk for a scope (0 when the file is absent). */
function pinnedOnDisk(scope: PinScope): number {
  const name = scope === "global" ? "global.json" : `${SLUG}.json`;
  const path = join(home, ".pi", "adhd", name);
  if (!existsSync(path)) return 0;
  const state = JSON.parse(readFileSync(path, "utf-8")) as { notes: unknown[] };
  return state.notes.length;
}

function storeWith(note: Note): NotesStore {
  const store = new NotesStore();
  store.add(note);
  return store;
}

describe("nextPinScope", () => {
  it("pins an unpinned note to the requested scope", () => {
    expect(nextPinScope(null, "project")).toBe("project");
    expect(nextPinScope(null, "global")).toBe("global");
  });

  it("unpins when the requested scope is the one already held", () => {
    expect(nextPinScope("project", "project")).toBeNull();
    expect(nextPinScope("global", "global")).toBeNull();
  });

  it("moves between scopes", () => {
    expect(nextPinScope("project", "global")).toBe("global");
    expect(nextPinScope("global", "project")).toBe("project");
  });
});

describe("applyPin", () => {
  it("pins an unpinned note and writes it to disk", () => {
    const note = createNote("Pay rent", "Pay rent", "reminder");
    const store = storeWith(note);

    expect(applyPin(store, note.id, "project", SLUG)).toBe("project");
    expect(store.get(note.id)?.pinned).toBe("project");
    expect(pinnedOnDisk("project")).toBe(1);
  });

  it("can pin straight to the global scope", () => {
    const note = createNote("Pay rent", "Pay rent", "reminder");
    const store = storeWith(note);

    expect(applyPin(store, note.id, "global", SLUG)).toBe("global");
    expect(pinnedOnDisk("global")).toBe(1);
    expect(pinnedOnDisk("project")).toBe(0);
  });

  it("unpins on a second press of the same scope, and clears the file", () => {
    const note = createNote("Pay rent", "Pay rent", "reminder");
    const store = storeWith(note);

    applyPin(store, note.id, "project", SLUG);
    expect(applyPin(store, note.id, "project", SLUG)).toBeNull();

    expect(store.get(note.id)?.pinned).toBeNull();
    expect(pinnedOnDisk("project")).toBe(0);
    expect(loadPinned(SLUG)).toHaveLength(0);
  });

  it("moves between scopes without leaving the old file dirty", () => {
    const note = createNote("Pay rent", "Pay rent", "reminder");
    const store = storeWith(note);

    applyPin(store, note.id, "project", SLUG);
    applyPin(store, note.id, "global", SLUG);

    expect(pinnedOnDisk("project")).toBe(0);
    expect(pinnedOnDisk("global")).toBe(1);
    // Exactly one note — and not merely because loadPinned() dedupes by id.
    expect(loadPinned(SLUG)).toHaveLength(1);
  });

  it("can go back to the project scope after a global pin", () => {
    const note = createNote("Pay rent", "Pay rent", "reminder");
    const store = storeWith(note);

    applyPin(store, note.id, "global", SLUG);
    applyPin(store, note.id, "project", SLUG);

    expect(pinnedOnDisk("global")).toBe(0);
    expect(pinnedOnDisk("project")).toBe(1);
  });

  it("keeps two notes in one scope independent", () => {
    const a = createNote("A", "A", "reminder");
    const b = createNote("B", "B", "reminder");
    const store = storeWith(a);
    store.add(b);

    applyPin(store, a.id, "project", SLUG);
    applyPin(store, b.id, "project", SLUG);
    expect(pinnedOnDisk("project")).toBe(2);

    applyPin(store, a.id, "project", SLUG); // unpin only A
    expect(pinnedOnDisk("project")).toBe(1);
    expect(store.get(a.id)?.pinned).toBeNull();
    expect(store.get(b.id)?.pinned).toBe("project");
  });

  it("ignores an unknown note id", () => {
    const store = new NotesStore();

    expect(applyPin(store, "missing", "project", SLUG)).toBeNull();
    expect(pinnedOnDisk("project")).toBe(0);
  });
});
