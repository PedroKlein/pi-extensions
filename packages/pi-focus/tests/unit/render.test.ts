import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFocus, renderResumeCard } from "../../src/render.js";
import type { FocusSnapshot } from "../../src/state.js";

const focus: FocusSnapshot = {
  goal: "Add incremental repository synchronization",
  now: "Fixing cache invalidation",
  then: "Resume index tests",
  state: "active",
  expectedDurationMs: 3 * 60 * 60_000,
  updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
};

describe("renderFocus", () => {
  it.each([
    [false, "Now"],
    [true, "Last focus"],
  ])("labels active focus honestly when settled=%s", (settled, label) => {
    const lines = renderFocus(focus, { settled }, 120);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("▌ FOCUS  Add incremental repository synchronization");
    expect(lines[0]).toContain("ACTIVE");
    expect(lines[1]).toContain(`▌ ${label === "Now" ? "NOW " : "LAST"}   Fixing cache invalidation`);
    expect(lines[2]).toContain("▌ NEXT   Resume index tests");
  });

  it.each([
    ["waiting", "WAIT"],
    ["blocked", "BLOCK"],
    ["done", "DONE"],
  ] as const)("renders %s state", (state, label) => {
    expect(renderFocus({ ...focus, state }, { settled: false }, 120)[1]).toContain(`▌ ${label}`);
  });

  it("adds one width-bounded execution line with a coarse duration", () => {
    const lines = renderFocus(focus, {
      settled: false,
      execution: { label: "integration tests", elapsedMs: 6 * 60_000 + 12_000, outputAgoMs: 18_000 },
    }, 120);

    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("▌ RUN    integration tests · 6m12s · expected 2–4h · output 18s ago");
    expect(renderFocus(focus, { settled: false }, 120)).toHaveLength(3);
  });

  it("uses theme hierarchy and warning color for stalled execution", () => {
    const colors: string[] = [];
    const theme = {
      fg: (color: string, text: string) => { colors.push(color); return text; },
      bold: (text: string) => text,
    };
    renderFocus(focus, {
      settled: false,
      execution: { label: "checks", elapsedMs: 120_000, possiblyStalled: true },
    }, 80, theme);
    expect(colors).toContain("accent");
    expect(colors).toContain("success");
    expect(colors).toContain("muted");
    expect(colors).toContain("warning");
    expect(colors).toContain("dim");
  });

  it("omits NEXT when no Then is declared", () => {
    expect(renderFocus({ ...focus, then: undefined }, { settled: false }, 120)).toHaveLength(2);
  });

  it.each([12, 20, 40])("never exceeds width %d", (width) => {
    for (const line of renderFocus(focus, {
      settled: false,
      execution: { label: "a very long execution label", elapsedMs: 90_000 },
    }, width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("renderResumeCard", () => {
  it("summarizes unfinished focus", () => {
    expect(renderResumeCard(focus)).toBe([
      "Resume · Add incremental repository synchronization",
      "Stopped at · Fixing cache invalidation",
      "Next · Resume index tests",
      "Updated · 2026-01-02 03:04 UTC",
    ].join("\n"));
  });

  it("includes an interrupted declared-long operation safely", () => {
    expect(renderResumeCard(focus, {
      version: 1,
      kind: "execution-start",
      id: "call-1",
      toolName: "bash",
      label: "integration tests",
      expectedDurationMs: 2 * 86_400_000,
      at: 100,
    })).toContain("Interrupted · integration tests · expected 2–7d");
  });

  it("omits completed focus", () => {
    expect(renderResumeCard({ ...focus, state: "done" })).toBeNull();
  });
});
