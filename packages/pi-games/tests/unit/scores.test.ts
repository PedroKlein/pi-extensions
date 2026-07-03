import { describe, it, expect, vi } from "vitest";
import {
  loadScores,
  saveScores,
  getHighScore,
  recordScore,
} from "../../src/scores.js";
import type { ScoresState } from "../../src/types.js";

// ── Minimal mock for ExtensionAPI (only appendEntry is used by scores.ts) ──

function makeMockPi() {
  return {
    appendEntry: vi.fn(),
  } as any;
}

// ── Minimal mock for ExtensionContext (only sessionManager.getEntries used) ──

function makeMockCtx(entries: any[] = []) {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  } as any;
}

// ────────────────────────────────────────────────────────────────────────────

describe("loadScores", () => {
  it("returns empty state when there are no entries", () => {
    const ctx = makeMockCtx([]);
    const state = loadScores(ctx);
    expect(state).toEqual({ scores: [] });
  });

  it("ignores entries that are not custom pi-games-scores type", () => {
    const ctx = makeMockCtx([
      { type: "message", data: {} },
      { type: "custom", customType: "something-else", data: { scores: [{ gameId: "snake", score: 99, date: 1 }] } },
    ]);
    const state = loadScores(ctx);
    expect(state.scores).toHaveLength(0);
  });

  it("loads scores from a matching entry", () => {
    const stored = [{ gameId: "snake", score: 50, date: 1000 }];
    const ctx = makeMockCtx([
      { type: "custom", customType: "pi-games-scores", data: { scores: stored } },
    ]);
    const state = loadScores(ctx);
    expect(state.scores).toEqual(stored);
  });

  it("uses the last matching entry when multiple exist", () => {
    const ctx = makeMockCtx([
      { type: "custom", customType: "pi-games-scores", data: { scores: [{ gameId: "snake", score: 10, date: 1 }] } },
      { type: "custom", customType: "pi-games-scores", data: { scores: [{ gameId: "snake", score: 20, date: 2 }] } },
    ]);
    const state = loadScores(ctx);
    // last entry wins (loop overwrites state.scores)
    expect(state.scores[0].score).toBe(20);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("saveScores", () => {
  it("calls appendEntry with the scores state", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [{ gameId: "flappy", score: 5, date: 123 }] };
    saveScores(pi, state);
    expect(pi.appendEntry).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledWith("pi-games-scores", state);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("getHighScore", () => {
  it("returns 0 when no scores for game", () => {
    const state: ScoresState = { scores: [] };
    expect(getHighScore(state, "snake")).toBe(0);
  });

  it("returns 0 when scores exist for a different game only", () => {
    const state: ScoresState = { scores: [{ gameId: "flappy", score: 99, date: 1 }] };
    expect(getHighScore(state, "snake")).toBe(0);
  });

  it("returns highest score across multiple entries", () => {
    const state: ScoresState = {
      scores: [
        { gameId: "snake", score: 30, date: 1 },
        { gameId: "snake", score: 80, date: 2 },
        { gameId: "snake", score: 50, date: 3 },
      ],
    };
    expect(getHighScore(state, "snake")).toBe(80);
  });

  it("ignores scores from other games", () => {
    const state: ScoresState = {
      scores: [
        { gameId: "flappy", score: 999, date: 1 },
        { gameId: "snake", score: 40, date: 2 },
      ],
    };
    expect(getHighScore(state, "snake")).toBe(40);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("recordScore", () => {
  it("appends score entry to state", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [] };
    recordScore(pi, state, "snake", 10);
    expect(state.scores).toHaveLength(1);
    expect(state.scores[0]).toMatchObject({ gameId: "snake", score: 10 });
  });

  it("calls saveScores (appendEntry) after recording", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [] };
    recordScore(pi, state, "snake", 10);
    expect(pi.appendEntry).toHaveBeenCalledOnce();
  });

  it("returns true when score is a new high (and > 0)", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [{ gameId: "snake", score: 20, date: 1 }] };
    const isNew = recordScore(pi, state, "snake", 30);
    expect(isNew).toBe(true);
  });

  it("returns false when score does not beat previous high", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [{ gameId: "snake", score: 50, date: 1 }] };
    const isNew = recordScore(pi, state, "snake", 40);
    expect(isNew).toBe(false);
  });

  it("returns false when score equals previous high", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [{ gameId: "snake", score: 50, date: 1 }] };
    const isNew = recordScore(pi, state, "snake", 50);
    expect(isNew).toBe(false);
  });

  it("returns false when score is 0, even if it's the first entry", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [] };
    const isNew = recordScore(pi, state, "snake", 0);
    expect(isNew).toBe(false);
  });

  it("records entries for multiple games independently", () => {
    const pi = makeMockPi();
    const state: ScoresState = { scores: [] };
    recordScore(pi, state, "snake", 10);
    recordScore(pi, state, "flappy", 5);
    expect(getHighScore(state, "snake")).toBe(10);
    expect(getHighScore(state, "flappy")).toBe(5);
  });
});
