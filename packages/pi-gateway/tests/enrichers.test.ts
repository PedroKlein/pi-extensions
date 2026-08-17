import { describe, expect, it } from "vitest";

import { enrichQuota } from "../src/enrichers.js";
import { classifyCapEvent } from "../src/detect.js";
import type { AliasesConfig } from "../src/config.js";

const REAL_HAI_402 =
	'{"error":{"cap_eur":"50.00","code":"DAILY_CAP_EXCEEDED","message":"Daily spending limit reached (€50.27 of €50.00). Resets at midnight UTC.","spent_eur":"50.27","type":"billing_error"}}';

describe("enrichQuota — hai-daily-eur", () => {
	it("extracts spent 50.27 / cap 50.00 / EUR from the real HAI 402 body", () => {
		const q = enrichQuota("hai-daily-eur", REAL_HAI_402);
		expect(q).toEqual({ spent: 50.27, cap: 50.0, currency: "EUR" });
	});

	it("returns undefined on missing cap_eur", () => {
		const body = JSON.stringify({ error: { code: "DAILY_CAP_EXCEEDED", spent_eur: "10" } });
		expect(enrichQuota("hai-daily-eur", body)).toBeUndefined();
	});

	it("returns undefined on wrong error code", () => {
		const body = JSON.stringify({
			error: { code: "RATE_LIMIT", cap_eur: "50", spent_eur: "50" },
		});
		expect(enrichQuota("hai-daily-eur", body)).toBeUndefined();
	});

	it("returns undefined on non-numeric cap_eur", () => {
		const body = JSON.stringify({
			error: { code: "DAILY_CAP_EXCEEDED", cap_eur: "not-a-number", spent_eur: "50" },
		});
		expect(enrichQuota("hai-daily-eur", body)).toBeUndefined();
	});

	it("returns undefined on invalid JSON", () => {
		expect(enrichQuota("hai-daily-eur", "not json")).toBeUndefined();
	});

	it("returns undefined when hint is undefined", () => {
		expect(enrichQuota(undefined, REAL_HAI_402)).toBeUndefined();
	});
});

describe("classifyCapEvent — quota attached when quotaHint declared", () => {
	const CFG: AliasesConfig = {
		fallbackChain: ["hai-proxy"],
		backends: {
			"hai-proxy": {
				resetSchedule: "utc-midnight",
				tiers: { heavy: ["hai-heavy"] },
				quotaHint: "hai-daily-eur",
				capStatusCodes: [402],
			},
		},
	};

	it("attaches quota { spent, cap, currency } to the unhealthy entry", () => {
		const r = classifyCapEvent(
			{
				errorMessage: `402: ${REAL_HAI_402}`,
				stopReason: "error",
				provider: "gateway",
				modelId: "heavy-1",
			},
			CFG,
			new Date("2025-01-15T12:00:00.000Z"),
		);
		expect(r.capHit).toBe(true);
		expect(r.entry?.quota).toEqual({ spent: 50.27, cap: 50.0, currency: "EUR" });
	});

	it("does not attach quota when quotaHint is undefined on the backend", () => {
		const cfg: AliasesConfig = {
			fallbackChain: ["hai-proxy"],
			backends: {
				"hai-proxy": {
					resetSchedule: "utc-midnight",
					tiers: { heavy: ["hai-heavy"] },
					quotaHint: undefined,
					capStatusCodes: [402],
				},
			},
		};
		const r = classifyCapEvent(
			{
				errorMessage: `402: ${REAL_HAI_402}`,
				stopReason: "error",
				provider: "gateway",
				modelId: "heavy-1",
			},
			cfg,
			new Date("2025-01-15T12:00:00.000Z"),
		);
		expect(r.capHit).toBe(true);
		expect(r.entry?.quota).toBeUndefined();
	});
});
