/**
 * Reset-schedule presets: given a "now" instant, compute the next instant
 * at which a backend's daily/monthly/hourly cap resets.
 *
 * Presets shipped in v1:
 *   utc-midnight      — daily reset at 00:00 UTC
 *   utc-monthly-1st   — monthly reset at 00:00 UTC on the 1st
 *   utc-hourly        — hourly reset at :00
 * Missing / unrecognized preset defaults to `now + 1 hour`.
 */

import type { ResetSchedule } from "./config.js";

export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function nextResetInstant(
	schedule: ResetSchedule | undefined,
	now: Date,
): Date {
	switch (schedule) {
		case "utc-midnight":
			return nextUtcMidnight(now);
		case "utc-monthly-1st":
			return nextUtcMonthlyFirst(now);
		case "utc-hourly":
			return nextUtcHourly(now);
		default:
			return new Date(now.getTime() + DEFAULT_TTL_MS);
	}
}

function nextUtcMidnight(now: Date): Date {
	// Advance to the next 00:00 UTC. If already 00:00, jump to tomorrow's.
	const t = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
		0,
		0,
		0,
		0,
	);
	return new Date(t);
}

function nextUtcMonthlyFirst(now: Date): Date {
	// Next month's 1st at 00:00 UTC.
	const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
	return new Date(t);
}

function nextUtcHourly(now: Date): Date {
	// Next :00 UTC. If already :00:00.000, jump to next hour.
	const next = new Date(now);
	next.setUTCMilliseconds(0);
	next.setUTCSeconds(0);
	next.setUTCMinutes(0);
	next.setUTCHours(next.getUTCHours() + 1);
	return next;
}
