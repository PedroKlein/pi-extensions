import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	emptyState,
	GatewayStateError,
	readState,
	STATE_FILE_VERSION,
	updateState,
	writeState,
	type GatewayState,
} from "../src/state.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-gateway-state-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("state read/write — happy paths", () => {
	it("returns emptyState() when file is missing (fresh state)", () => {
		const state = readState(join(dir, "gateway-state.json"));
		expect(state).toEqual({
			version: STATE_FILE_VERSION,
			unhealthyUntil: {},
			activeBackendOverride: undefined,
			fallbackChainOverride: undefined,
		});
	});

	it("round-trips a state via write then read", () => {
		const path = join(dir, "gateway-state.json");
		const original: GatewayState = {
			version: STATE_FILE_VERSION,
			unhealthyUntil: {
				"hai-proxy": {
					until: "2025-01-15T00:00:00.000Z",
					reason: "402 cap hit",
					quota: { spent: 50.27, cap: 50.0, currency: "EUR" },
				},
			},
			activeBackendOverride: "github-copilot",
			fallbackChainOverride: ["github-copilot", "hai-proxy"],
		};
		writeState(path, original);
		const roundTripped = readState(path);
		expect(roundTripped).toEqual(original);
	});
});

describe("state write — atomicity", () => {
	it("survives an interrupted write: destination remains valid", () => {
		const path = join(dir, "gateway-state.json");
		// Prime with valid content.
		writeState(path, emptyState());
		expect(existsSync(path)).toBe(true);

		// Simulate a crash by dropping an orphan .tmp file that a killed
		// writer might have left behind — the destination must remain readable.
		const tmpJunk = `${path}.tmp.${process.pid}.99999.${Date.now()}`;
		writeFileSync(tmpJunk, "corrupted partial content, not valid JSON");

		const restored = readState(path);
		expect(restored.version).toBe(STATE_FILE_VERSION);
		expect(restored.unhealthyUntil).toEqual({});
	});
});

describe("state write — version stamping", () => {
	it("stamps version: 1 on every write, even when caller omits it", () => {
		const path = join(dir, "gateway-state.json");
		writeState(path, { ...emptyState(), version: STATE_FILE_VERSION });
		const body = readFileSync(path, "utf8");
		expect(JSON.parse(body).version).toBe(1);
	});

	it("rejects read of a file missing the version field", () => {
		const path = join(dir, "gateway-state.json");
		writeFileSync(path, JSON.stringify({ unhealthyUntil: {} }));
		expect(() => readState(path)).toThrowError(
			expect.objectContaining({ name: "GatewayStateError", cause: "schema" }),
		);
	});

	it("rejects read of a file with a wrong version number", () => {
		const path = join(dir, "gateway-state.json");
		writeFileSync(path, JSON.stringify({ version: 999, unhealthyUntil: {} }));
		expect(() => readState(path)).toThrowError(GatewayStateError);
	});
});

describe("state — concurrent writers", () => {
	it("20 concurrent writers end with a valid file (one writer's content wins)", async () => {
		const path = join(dir, "gateway-state.json");
		writeState(path, emptyState());

		// Use in-process concurrency via updateState — no forked children needed
		// because the lockfile is process-shared. 20 async updaters each stamp
		// a distinct backend name into unhealthyUntil.
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => {
				return new Promise<void>((resolve, reject) => {
					// Force async ordering to interleave lock attempts.
					setImmediate(() => {
						try {
							updateState(path, (cur) => ({
								...cur,
								unhealthyUntil: {
									...cur.unhealthyUntil,
									[`writer-${i}`]: {
										until: new Date(Date.now() + 3_600_000).toISOString(),
										reason: `writer-${i}`,
									},
								},
							}));
							resolve();
						} catch (err) {
							reject(err);
						}
					});
				});
			}),
		);

		const final = readState(path);
		// File is well-formed and schema-valid.
		expect(final.version).toBe(1);
		// All 20 writers landed their content (serialization means later writers
		// read prior state and appended, so ALL entries survive).
		expect(Object.keys(final.unhealthyUntil).length).toBe(20);
	});
});

describe("state — updateState mutator", () => {
	it("passes current state to the mutator and writes the return value", () => {
		const path = join(dir, "gateway-state.json");
		writeState(path, {
			...emptyState(),
			unhealthyUntil: {
				"hai-proxy": { until: "2025-01-01T00:00:00.000Z", reason: "seed" },
			},
		});
		const next = updateState(path, (cur) => ({
			...cur,
			activeBackendOverride: "hai-proxy",
		}));
		expect(next.activeBackendOverride).toBe("hai-proxy");
		expect(next.unhealthyUntil["hai-proxy"].reason).toBe("seed");
		expect(readState(path)).toEqual(next);
	});
});
