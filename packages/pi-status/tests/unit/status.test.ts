import { describe, it, expect } from "vitest";
import { fmt, shortModel, buildBar } from "../../src/index.js";
import type { Segment, RegisterPayload, UpdatePayload } from "../../src/types.js";

// ─── fmt ───────────────────────────────────────────────────────────────────

describe("fmt", () => {
  it("returns raw number for values under 1k", () => {
    expect(fmt(0)).toBe("0");
    expect(fmt(1)).toBe("1");
    expect(fmt(999)).toBe("999");
  });

  it("rounds to k for values in thousands", () => {
    expect(fmt(1000)).toBe("1k");
    expect(fmt(1500)).toBe("2k");
    expect(fmt(999_999)).toBe("1000k");
  });

  it("formats millions with one decimal when under 10M", () => {
    expect(fmt(1_000_000)).toBe("1.0M");
    expect(fmt(5_500_000)).toBe("5.5M");
    expect(fmt(9_999_999)).toBe("10.0M");
  });

  it("rounds millions to whole number at 10M+", () => {
    expect(fmt(10_000_000)).toBe("10M");
    expect(fmt(25_300_000)).toBe("25M");
  });
});

// ─── shortModel ────────────────────────────────────────────────────────────

describe("shortModel", () => {
  it("returns 'no-model' for undefined", () => {
    expect(shortModel(undefined)).toBe("no-model");
  });

  it("strips 'Claude ' prefix (with space) from display names", () => {
    expect(shortModel({ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" })).toBe("3.5 Sonnet");
    // id without a space after 'claude' is not stripped — regex targets 'Claude ' with space
    expect(shortModel({ id: "claude-opus" })).toBe("claude-opus");
  });

  it("strips 'Anthropic: ' prefix, leaving any remaining Claude prefix intact", () => {
    // Only one pass of stripping — 'Anthropic: ' is removed, 'Claude ' stays
    expect(shortModel({ id: "x", name: "Anthropic: Claude 3.7" })).toBe("Claude 3.7");
  });

  it("strips parenthetical suffixes", () => {
    expect(shortModel({ id: "x", name: "Claude 3.5 Sonnet (20241022)" })).toBe("3.5 Sonnet");
  });

  it("falls back to id when name is not set", () => {
    expect(shortModel({ id: "some-model-id" })).toBe("some-model-id");
  });

  it("uses name over id when name is set", () => {
    expect(shortModel({ id: "id-value", name: "Display Name" })).toBe("Display Name");
  });
});

// ─── buildBar ──────────────────────────────────────────────────────────────

describe("buildBar", () => {
  const mockTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
  };

  it("produces a bar of the requested width", () => {
    const bar = buildBar(0.5, 10, mockTheme);
    // filled (5) + empty (5) = 10 chars of block characters
    const blockChars = bar.replace(/\[[^\]]+\]/g, (m) => {
      const content = m.match(/\[.+:(.+)\]/)?.[1] ?? "";
      return content;
    });
    const blocks = (blockChars.match(/▓/g) ?? []).length;
    const empties = (blockChars.match(/░/g) ?? []).length;
    expect(blocks + empties).toBe(10);
  });

  it("clamps pct below 0 to 0 (all empty)", () => {
    const bar = buildBar(-1, 4, mockTheme);
    expect(bar).toContain("░░░░");
    expect(bar).not.toContain("▓");
  });

  it("clamps pct above 1 to 1 (all filled)", () => {
    const bar = buildBar(2, 4, mockTheme);
    expect(bar).toContain("▓▓▓▓");
    expect(bar).not.toContain("░");
  });

  it("uses 'success' color under 60%", () => {
    const bar = buildBar(0.3, 4, mockTheme);
    expect(bar).toContain("[success:");
  });

  it("uses 'warning' color at 60–89%", () => {
    const bar = buildBar(0.7, 4, mockTheme);
    expect(bar).toContain("[warning:");
  });

  it("uses 'error' color at 90%+", () => {
    const bar = buildBar(0.95, 4, mockTheme);
    expect(bar).toContain("[error:");
  });
});

// ─── Types structural tests ─────────────────────────────────────────────────

describe("types", () => {
  it("Segment requires id, priority, render", () => {
    const seg: Segment = {
      id: "test",
      priority: 50,
      render: (_theme) => "text",
    };
    expect(seg.id).toBe("test");
    expect(seg.priority).toBe(50);
    expect(seg.render({})).toBe("text");
  });

  it("RegisterPayload has optional priority", () => {
    const minimal: RegisterPayload = { id: "x", render: () => "" };
    expect(minimal.priority).toBeUndefined();

    const full: RegisterPayload = { id: "x", priority: 75, render: () => "hi" };
    expect(full.priority).toBe(75);
  });

  it("UpdatePayload allows null render for removal", () => {
    const remove: UpdatePayload = { id: "x", render: null };
    expect(remove.render).toBeNull();

    const update: UpdatePayload = { id: "x", render: () => "new" };
    expect(update.render).not.toBeNull();
  });

  it("segments sort by priority descending", () => {
    const segs: Segment[] = [
      { id: "low", priority: 10, render: () => "L" },
      { id: "high", priority: 90, render: () => "H" },
      { id: "mid", priority: 50, render: () => "M" },
    ];
    const sorted = [...segs].sort((a, b) => b.priority - a.priority);
    expect(sorted.map((s) => s.id)).toEqual(["high", "mid", "low"]);
  });
});
