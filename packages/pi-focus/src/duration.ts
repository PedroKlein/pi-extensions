const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;
const month = 30 * day;
const year = 365 * day;

const unitMilliseconds = {
  s: second,
  m: minute,
  h: hour,
  d: day,
  w: week,
  mo: month,
  y: year,
} as const;

export function parseDuration(input: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(s|m|h|d|w|mo|y)$/i.exec(input.trim());
  if (!match) throw new Error("expected duration like 45m, 3h, or 2d");

  const value = Number(match[1]);
  const unit = match[2].toLowerCase() as keyof typeof unitMilliseconds;
  const milliseconds = Math.round(value * unitMilliseconds[unit]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("expected duration must be a positive safe duration");
  }
  return milliseconds;
}

const bands: Array<[number, string]> = [
  [minute, "<1m"],
  [5 * minute, "1–5m"],
  [20 * minute, "5–20m"],
  [hour, "20–60m"],
  [2 * hour, "1–2h"],
  [4 * hour, "2–4h"],
  [8 * hour, "4–8h"],
  [day, "8–24h"],
  [2 * day, "1–2d"],
  [week, "2–7d"],
  [2 * week, "1–2w"],
  [4 * week, "2–4w"],
  [3 * month, "1–3mo"],
  [6 * month, "3–6mo"],
  [12 * month, "6–12mo"],
];

export function formatDurationInput(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("duration must be a positive safe integer");
  }
  for (const [unit, size] of [
    ["y", year],
    ["mo", month],
    ["w", week],
    ["d", day],
    ["h", hour],
    ["m", minute],
    ["s", second],
  ] as const) {
    if (milliseconds >= size && milliseconds % size === 0) return `${milliseconds / size}${unit}`;
  }
  return `${milliseconds / second}s`;
}

export function durationBand(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("duration must be a positive safe integer");
  }

  for (const [upperBound, label] of bands) {
    if (milliseconds < upperBound) return label;
  }

  const years = milliseconds / year;
  let lower = 1;
  while (years >= lower * 2) lower *= 2;
  return `${lower}–${lower * 2}y`;
}
