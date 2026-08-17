import { describe, expect, it } from "vitest";

import type { AliasesConfig } from "../src/config.js";
import { applyCapOutcome, classifyCapEvent, parseStatusPrefix } from "../src/detect.js";
import { nextResetInstant } from "../src/reset-schedule.js";
import { emptyState, type GatewayState } from "../src/state.js";

const CFG: AliasesConfig = {
	fallbackChain: ["openrouter", "github-copilot"],
	backends: {
		"openrouter": {
			resetSchedule: "utc-midnight",
			tiers: { heavy: ["or-heavy"], light: ["or-light"] },
			quotaHint: "daily-eur-cap",
			capStatusCodes: [402, 429],
		},
		"github-copilot": {
			resetSchedule: "utc-monthly-1st",
			tiers: { heavy: ["copilot-heavy"] },
			quotaHint: undefined,
			capStatusCodes: [402],
		},
	},
};

// -- nextResetInstant ------------------------------------------------------

describe("nextResetInstant", () => {
	it("utc-midnight at 12:30 UTC → next 00:00 UTC (same day + 1)", () => {
		const now = new Date("2025-01-15T12:30:00.000Z");
		const next = nextResetInstant("utc-midnight", now);
		expect(next.toISOString()).toBe("2025-01-16T00:00:00.000Z");
	});
	it("utc-midnight at 23:59:59.999 UTC → tomorrow 00:00 UTC", () => {
		const now = new Date("2025-01-15T23:59:59.999Z");
		const next = nextResetInstant("utc-midnight", now);
		expect(next.toISOString()).toBe("2025-01-16T00:00:00.000Z");
	});
	it("utc-monthly-1st at day 15 → 1st of next month", () => {
		const now = new Date("2025-01-15T12:00:00.000Z");
		const next = nextResetInstant("utc-monthly-1st", now);
		expect(next.toISOString()).toBe("2025-02-01T00:00:00.000Z");
	});
	it("utc-monthly-1st in December → January of next year", () => {
		const now = new Date("2025-12-20T00:00:00.000Z");
		const next = nextResetInstant("utc-monthly-1st", now);
		expect(next.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});
	it("utc-hourly at :30 → next :00", () => {
		const now = new Date("2025-01-15T12:30:12.500Z");
		const next = nextResetInstant("utc-hourly", now);
		expect(next.toISOString()).toBe("2025-01-15T13:00:00.000Z");
	});
	it("undefined preset → now + 1h", () => {
		const now = new Date("2025-01-15T12:30:00.000Z");
		const next = nextResetInstant(undefined, now);
		expect(next.getTime() - now.getTime()).toBe(3600 * 1000);
	});
});

// -- parseStatusPrefix -----------------------------------------------------

describe("parseStatusPrefix", () => {
	it("parses '402: {json}'", () => {
		const r = parseStatusPrefix('402: {"error":{"code":"DAILY_CAP_EXCEEDED"}}');
		expect(r?.status).toBe(402);
		expect(r?.body).toBe('{"error":{"code":"DAILY_CAP_EXCEEDED"}}');
	});
	it("parses '429: rate limit exceeded' (non-JSON body)", () => {
		const r = parseStatusPrefix("429: rate limit exceeded");
		expect(r?.status).toBe(429);
		expect(r?.body).toBe("rate limit exceeded");
	});
	it("returns undefined for messages without status prefix", () => {
		expect(parseStatusPrefix("some other error")).toBeUndefined();
	});
	it("returns undefined for out-of-range status", () => {
		expect(parseStatusPrefix("99: too low")).toBeUndefined();
		expect(parseStatusPrefix("600: too high")).toBeUndefined();
	});
});

// -- classifyCapEvent ------------------------------------------------------

describe("classifyCapEvent", () => {
	const CAP_402 = '402: {"error":{"cap_eur":"50.00","code":"DAILY_CAP_EXCEEDED","message":"Daily spending limit reached (€50.27 of €50.00)","spent_eur":"50.27","type":"billing_error"}}';
	const NOW = new Date("2025-01-15T12:30:00.000Z");

	it("attributes a cap hit via the compose-time routing map (indexed alias)", () => {
		const routing = { "heavy-1": "openrouter", "heavy-2": "openrouter" };
		const r = classifyCapEvent(
			{
				errorMessage: CAP_402,
				stopReason: "error",
				provider: "gateway",
				modelId: "heavy-2",
			},
			CFG,
			NOW,
			routing,
		);
		expect(r.capHit).toBe(true);
		expect(r.backendName).toBe("openrouter");
		expect(r.status).toBe(402);
		expect(r.entry?.until).toBe("2025-01-16T00:00:00.000Z");
		expect(r.body).toContain("DAILY_CAP_EXCEEDED");
	});

	it("routing map wins over the tier-slot fallback (heavy-1 routed to secondary under failover)", () => {
		// heavy-1 is normally openrouter, but under failover it routed to copilot.
		// The routing map is authoritative, so the cap is attributed to copilot.
		const routing = { "heavy-1": "github-copilot" };
		const r = classifyCapEvent(
			{
				errorMessage: "402: {}",
				stopReason: "error",
				provider: "gateway",
				modelId: "heavy-1",
			},
			CFG,
			NOW,
			routing,
		);
		expect(r.capHit).toBe(true);
		expect(r.backendName).toBe("github-copilot");
		expect(r.entry?.until).toBe("2025-02-01T00:00:00.000Z");
	});

	it("falls back to the first chain backend for the tier when no routing map is given", () => {
		const r = classifyCapEvent(
			{
				errorMessage: CAP_402,
				stopReason: "error",
				provider: "gateway",
				modelId: "heavy-1",
			},
			CFG,
			NOW,
		);
		expect(r.capHit).toBe(true);
		// openrouter is first in the chain and declares heavy → attribution lands there.
		expect(r.backendName).toBe("openrouter");
	});

	it("unknown alias with no routing entry → capHit false (never mis-attributes)", () => {
		const r = classifyCapEvent(
			{
				errorMessage: "402: {}",
				stopReason: "error",
				provider: "gateway",
				modelId: "bogus-9",
			},
			CFG,
			NOW,
			{},
		);
		expect(r.capHit).toBe(false);
	});

	it("ignores 200 (successful) responses", () => {
		const r = classifyCapEvent(
			{ errorMessage: undefined, stopReason: "stop", provider: "gateway", modelId: "heavy-1" },
			CFG,
			NOW,
		);
		expect(r.capHit).toBe(false);
	});

	it("ignores 402 on a non-gateway provider (user selected direct anthropic)", () => {
		const r = classifyCapEvent(
			{
				errorMessage: CAP_402,
				stopReason: "error",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
			CFG,
			NOW,
		);
		expect(r.capHit).toBe(false);
	});

	it("ignores 500 (not in capStatusCodes)", () => {
		const r = classifyCapEvent(
			{ errorMessage: "500: internal error", stopReason: "error", provider: "gateway", modelId: "heavy-1" },
			CFG,
			NOW,
		);
		expect(r.capHit).toBe(false);
	});
});

// -- applyCapOutcome -------------------------------------------------------

describe("applyCapOutcome", () => {
	it("adds a new entry when none exists", () => {
		const state = emptyState();
		const next = applyCapOutcome(state, "openrouter", {
			until: "2025-01-16T00:00:00.000Z",
			reason: "402",
		});
		expect(next.unhealthyUntil["openrouter"].until).toBe("2025-01-16T00:00:00.000Z");
	});

	it("extends an existing entry when new until is later", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": { until: "2025-01-16T00:00:00.000Z", reason: "first" },
			},
		};
		const next = applyCapOutcome(state, "openrouter", {
			until: "2025-01-17T00:00:00.000Z",
			reason: "second",
		});
		expect(next.unhealthyUntil["openrouter"].until).toBe("2025-01-17T00:00:00.000Z");
		expect(next.unhealthyUntil["openrouter"].reason).toBe("second");
	});

	it("does NOT shorten an existing entry when new until is earlier", () => {
		const state: GatewayState = {
			...emptyState(),
			unhealthyUntil: {
				"openrouter": { until: "2025-01-17T00:00:00.000Z", reason: "first" },
			},
		};
		const next = applyCapOutcome(state, "openrouter", {
			until: "2025-01-16T00:00:00.000Z",
			reason: "second",
		});
		expect(next).toBe(state); // identity: no change
	});
});
