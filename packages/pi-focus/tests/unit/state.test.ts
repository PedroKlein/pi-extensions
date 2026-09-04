import { describe, expect, it } from "vitest";
import {
  FOCUS_ENTRY_TYPE,
  createClearTransition,
  createFocusTransition,
  replayFocusEntries,
  replayTelemetryEntries,
} from "../../src/state.js";

function entry(data: unknown) {
  return { type: "custom", customType: FOCUS_ENTRY_TYPE, data };
}

describe("focus state", () => {
  it("creates and replays explicit semantic transitions", () => {
    const first = createFocusTransition(null, {
      goal: "Ship pi-focus",
      now: "Defining state",
      then: "Add the tool",
      state: "active",
      expectedDurationMs: 3_600_000,
    }, "agent", 100);
    const second = createFocusTransition(first.snapshot, {
      now: "Running tests",
      state: "waiting",
      handoff: "Resume failing test",
    }, "agent", 200);

    const result = replayFocusEntries([entry(first), entry(second)]);

    expect(result.current).toEqual({
      goal: "Ship pi-focus",
      now: "Running tests",
      then: "Add the tool",
      state: "waiting",
      expectedDurationMs: 3_600_000,
      handoff: "Resume failing test",
      updatedAt: 200,
    });
    expect(result.transitions).toHaveLength(2);
  });

  it("requires a goal for the first transition", () => {
    expect(() => createFocusTransition(null, { now: "Working" }, "agent", 100)).toThrow(
      "goal",
    );
  });

  it("rejects invalid persisted state without losing valid history", () => {
    const valid = createFocusTransition(null, { goal: "Goal", now: "Start" }, "agent", 100);
    const result = replayFocusEntries([
      entry({ ...valid, version: 2 }),
      entry({ ...valid, snapshot: { ...valid.snapshot, expectedDurationMs: -1 } }),
      entry(valid),
    ]);

    expect(result.current?.goal).toBe("Goal");
    expect(result.transitions).toHaveLength(1);
  });

  it("keeps branch histories independent and records user clear", () => {
    const root = createFocusTransition(null, { goal: "Shared", now: "Root" }, "agent", 100);
    const left = createFocusTransition(root.snapshot, { now: "Left" }, "user", 200);
    const right = createFocusTransition(root.snapshot, { now: "Right" }, "agent", 300);

    expect(replayFocusEntries([entry(root), entry(left)]).current?.now).toBe("Left");
    expect(replayFocusEntries([entry(root), entry(right)]).current?.now).toBe("Right");

    const cleared = replayFocusEntries([entry(root), entry(left), entry(createClearTransition(400))]);
    expect(cleared.current).toBeNull();
    expect(cleared.transitions.map((transition) => transition.kind)).toEqual([
      "update",
      "update",
      "clear",
    ]);
  });

  it("can explicitly clear optional fields", () => {
    const first = createFocusTransition(null, {
      goal: "Goal",
      then: "Next",
      handoff: "Later",
      expectedDurationMs: 60_000,
    }, "agent", 100);
    const second = createFocusTransition(first.snapshot, {
      then: null,
      handoff: null,
      expectedDurationMs: null,
      state: "done",
    }, "agent", 200);

    expect(second.snapshot).toEqual({
      goal: "Goal",
      state: "done",
      updatedAt: 200,
    });
  });

  it("reconstructs only unmatched declared-long executions", () => {
    const startA = {
      version: 1, kind: "execution-start", id: "a", toolName: "bash",
      label: "integration tests", expectedDurationMs: 3_600_000, at: 100,
    };
    const startB = {
      version: 1, kind: "execution-start", id: "b", toolName: "subagent",
      label: "delegated review", expectedDurationMs: 86_400_000, at: 200,
    };
    const endA = { version: 1, kind: "execution-end", id: "a", toolName: "bash", label: "integration tests", at: 300 };
    const replay = replayTelemetryEntries([
      { type: "custom", customType: "pi-focus-telemetry", data: startA },
      { type: "custom", customType: "pi-focus-telemetry", data: startB },
      { type: "custom", customType: "pi-focus-telemetry", data: endA },
      { type: "custom", customType: "pi-focus-telemetry", data: { ...startA, id: " " } },
      { type: "custom", customType: "pi-focus-telemetry", data: { ...startA, expectedDurationMs: -1 } },
    ]);

    expect(replay.events).toHaveLength(3);
    expect(replay.interrupted).toEqual([startB]);
  });
});
