import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeSessionJsonl } from "../../src/session-usage.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/session-two-user-runs.jsonl", import.meta.url),
);

describe("analyzeSessionJsonl", () => {
  it("separates model-call usage for each user run", () => {
    const report = analyzeSessionJsonl(readFileSync(fixturePath, "utf8"));

    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]).toMatchObject({
      index: 1,
      userEntryId: "user-1",
      modelCallCount: 2,
      usage: {
        input: 7,
        cacheRead: 245,
        cacheWrite: 30,
        output: 18,
        reasoning: 7,
      },
      context: {
        firstCallTokens: 125,
        lastCallTokens: 157,
        growthTokens: 32,
        peakTokens: 157,
      },
    });
    expect(report.runs[1]).toMatchObject({
      index: 2,
      userEntryId: "user-2",
      modelCallCount: 1,
      usage: {
        input: 3,
        cacheRead: 157,
        cacheWrite: 5,
        output: 12,
        reasoning: 6,
      },
      context: {
        firstCallTokens: 165,
        lastCallTokens: 165,
        growthTokens: 0,
        peakTokens: 165,
      },
    });
    expect(report.totals).toEqual({
      userRunCount: 2,
      modelCallCount: 3,
      input: 10,
      cacheRead: 402,
      cacheWrite: 35,
      output: 30,
      reasoning: 13,
    });
  });
});
