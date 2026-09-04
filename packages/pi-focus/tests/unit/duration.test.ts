import { describe, expect, it } from "vitest";
import { durationBand, parseDuration } from "../../src/duration.js";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;
const month = 30 * day;
const year = 365 * day;

describe("parseDuration", () => {
  it.each([
    ["45s", 45_000],
    ["3m", 3 * minute],
    ["2h", 2 * hour],
    ["2d", 2 * day],
    ["1.5w", 1.5 * week],
    ["2mo", 2 * month],
    ["3y", 3 * year],
  ])("normalizes %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(["", "0m", "-1h", "one day", "1h30m", "Infinityy", "1e9y"])(
    "rejects %s",
    (input) => expect(() => parseDuration(input)).toThrow(),
  );

  it("rejects unsafe millisecond values", () => {
    expect(() => parseDuration("999999999y")).toThrow();
  });
});

describe("durationBand", () => {
  it.each([
    [minute - 1, "<1m"],
    [minute, "1–5m"],
    [5 * minute, "5–20m"],
    [20 * minute, "20–60m"],
    [hour, "1–2h"],
    [2 * hour, "2–4h"],
    [4 * hour, "4–8h"],
    [8 * hour, "8–24h"],
    [day, "1–2d"],
    [2 * day, "2–7d"],
    [week, "1–2w"],
    [2 * week, "2–4w"],
    [4 * week, "1–3mo"],
    [3 * month, "3–6mo"],
    [6 * month, "6–12mo"],
    [year, "1–2y"],
    [2 * year, "2–4y"],
    [3 * year, "2–4y"],
    [8 * year, "8–16y"],
    [64 * year, "64–128y"],
  ])("bands %dms as %s", (duration, expected) => {
    expect(durationBand(duration)).toBe(expected);
  });
});
