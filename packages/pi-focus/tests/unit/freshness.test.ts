import { describe, expect, it } from "vitest";
import { FreshnessTracker } from "../../src/freshness.js";

describe("FreshnessTracker", () => {
  it("becomes stale at three completed turns", () => {
    const freshness = new FreshnessTracker();
    freshness.completeTurn();
    freshness.completeTurn();
    expect(freshness.stale).toBe(false);
    freshness.completeTurn();
    expect(freshness.stale).toBe(true);
  });

  it("becomes stale at ten completed non-focus tools", () => {
    const freshness = new FreshnessTracker();
    for (let i = 0; i < 9; i++) freshness.completeTool("read");
    freshness.completeTool("focus_update");
    expect(freshness.stale).toBe(false);
    freshness.completeTool("bash");
    expect(freshness.stale).toBe(true);
  });

  it("delivers one reminder per stale epoch and resets on focus update", () => {
    const freshness = new FreshnessTracker();
    for (let i = 0; i < 3; i++) freshness.completeTurn();
    expect(freshness.takeReminder()).toBe(true);
    expect(freshness.takeReminder()).toBe(false);

    freshness.reset();
    expect(freshness.stale).toBe(false);
    for (let i = 0; i < 3; i++) freshness.completeTurn();
    expect(freshness.takeReminder()).toBe(true);
  });
});
