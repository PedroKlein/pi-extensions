import { describe, expect, it } from "vitest";
import {
  createContextThresholdState,
  shouldShowCompletionCheckpoint,
} from "../../src/thresholds.js";

describe("context threshold state", () => {
  it("emits each absolute crossing once until lifecycle reset", () => {
    const state = createContextThresholdState();

    expect(state.observe(99_999)).toEqual([]);
    expect(state.observe(100_000)).toEqual([100_000]);
    expect(state.observe(150_000)).toEqual([]);
    expect(state.observe(200_000)).toEqual([200_000]);
    expect(state.observe(360_000)).toEqual([350_000]);
    expect(state.observe(400_000)).toEqual([]);

    state.reset();
    expect(state.observe(360_000)).toEqual([100_000, 200_000, 350_000]);
  });

  it("shows task-completion cleanup only at or above 100k", () => {
    expect(shouldShowCompletionCheckpoint(99_999)).toBe(false);
    expect(shouldShowCompletionCheckpoint(100_000)).toBe(true);
    expect(shouldShowCompletionCheckpoint(350_000)).toBe(true);
  });
});
