import { describe, expect, it } from "vitest";
import { TelemetryTracker, stallThresholds } from "../../src/telemetry.js";

describe("stall thresholds", () => {
  it.each([
    [30_000, 120_000, 30_000],
    [3 * 60_000, 6 * 60_000, 30_000],
    [3 * 3_600_000, 6 * 3_600_000, 30 * 60_000],
    [86_400_000, 2 * 86_400_000, 4 * 3_600_000],
    [2 * 86_400_000, 4 * 86_400_000, 8 * 3_600_000],
    [14 * 86_400_000, 28 * 86_400_000, 24 * 3_600_000],
    [365 * 86_400_000, 730 * 86_400_000, 24 * 3_600_000],
  ])("derives thresholds for %dms", (expected, elapsed, silence) => {
    expect(stallThresholds(expected)).toEqual({ elapsedMs: elapsed, silenceMs: silence });
  });

  it("keeps arithmetic safe", () => {
    expect(stallThresholds(Number.MAX_SAFE_INTEGER).elapsedMs).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("TelemetryTracker", () => {
  it("tracks concurrent executions, output activity, and out-of-order completion", () => {
    let now = 1_000;
    const tracker = new TelemetryTracker(() => now);
    tracker.start("a", "bash", "integration tests", 300_000);
    now = 2_000;
    tracker.start("b", "read", "read");
    now = 4_000;
    tracker.update("a");

    expect(tracker.active()).toEqual([
      expect.objectContaining({ id: "a", startedAt: 1_000, lastOutputAt: 4_000 }),
      expect.objectContaining({ id: "b", startedAt: 2_000, lastOutputAt: 2_000 }),
    ]);

    tracker.end("b");
    expect(tracker.active().map((execution) => execution.id)).toEqual(["a"]);
    tracker.end("missing");
    tracker.end("a");
    expect(tracker.active()).toEqual([]);
  });

  it("prioritizes stalled, declared-long, then longest running", () => {
    let now = 0;
    const tracker = new TelemetryTracker(() => now);
    tracker.start("routine-old", "read", "read");
    now = 1_000;
    tracker.start("long", "bash", "integration tests", 300_000);
    now = 2_000;
    tracker.start("stalled", "bash", "database migration", 600_000);
    tracker.markPossiblyStalled("stalled");
    now = 5_000;

    expect(tracker.view()).toMatchObject({
      label: "database migration",
      elapsedMs: 3_000,
      possiblyStalled: true,
      otherCount: 2,
    });
    tracker.end("stalled");
    expect(tracker.view()?.label).toBe("integration tests");
    tracker.end("long");
    expect(tracker.view()?.label).toBe("read");
  });

  it("aggregates top-level subagents without inspecting arguments", () => {
    const tracker = new TelemetryTracker(() => 10_000);
    tracker.start("a", "subagent", "subagent");
    tracker.start("b", "subagent", "subagent");

    expect(tracker.view()).toMatchObject({ label: "subagents (2)", otherCount: 0 });
    expect(JSON.stringify(tracker.active())).not.toContain("secret prompt");
  });

  it("marks a stall only when elapsed and silence thresholds are both met", () => {
    let now = 0;
    const tracker = new TelemetryTracker(() => now);
    tracker.start("a", "bash", "long checks", 60_000);

    now = 119_999;
    expect(tracker.detectNewStalls()).toEqual([]);
    now = 120_000;
    tracker.update("a");
    expect(tracker.detectNewStalls()).toEqual([]);
    now = 150_000;
    expect(tracker.detectNewStalls().map((execution) => execution.id)).toEqual(["a"]);
    expect(tracker.detectNewStalls()).toEqual([]);
  });

  it("stores no raw arguments", () => {
    const tracker = new TelemetryTracker(() => 0);
    tracker.start("a", "bash", "bash");
    const serialized = JSON.stringify(tracker.active());
    expect(serialized).toBe('[{"id":"a","toolName":"bash","label":"bash","startedAt":0,"lastOutputAt":0}]');
  });
});
