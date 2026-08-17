import { describe, expect, it, vi } from "vitest";

import { installRefreshTimer } from "../src/refresh-timer.js";
import type { ResolvedBackend } from "../src/resolver.js";

function backend(name: string, authMode: ResolvedBackend["authMode"]): ResolvedBackend {
	return {
		name,
		authMode,
		apiKeyRaw: undefined,
		baseUrl: undefined,
		api: undefined,
		tiers: new Map(),
		config: { resetSchedule: undefined, tiers: {}, quotaHint: undefined, capStatusCodes: [402] },
	};
}

describe("installRefreshTimer — install decision", () => {
	it("does NOT install a timer when every backend is static", () => {
		const setInt = vi.fn();
		const clearInt = vi.fn();
		const handle = installRefreshTimer({
			backends: [backend("a", "static"), backend("b", "static")],
			isIdle: () => true,
			onTick: () => {},
			setInterval: setInt,
			clearInterval: clearInt,
		});
		expect(handle.installed).toBe(false);
		expect(setInt).not.toHaveBeenCalled();
	});

	it("installs a timer when at least one backend is 'resolved' (OAuth-shaped)", () => {
		const setInt = vi.fn().mockReturnValue({ id: 1 });
		const handle = installRefreshTimer({
			backends: [backend("a", "static"), backend("b", "resolved")],
			isIdle: () => true,
			onTick: () => {},
			setInterval: setInt,
			clearInterval: () => {},
		});
		expect(handle.installed).toBe(true);
		expect(setInt).toHaveBeenCalledTimes(1);
	});

	it("installs a timer when at least one backend is 'command' (rotating !command)", () => {
		const setInt = vi.fn().mockReturnValue({ id: 2 });
		const handle = installRefreshTimer({
			backends: [backend("a", "command")],
			isIdle: () => true,
			onTick: () => {},
			setInterval: setInt,
			clearInterval: () => {},
		});
		expect(handle.installed).toBe(true);
	});
});

describe("installRefreshTimer — tick behavior", () => {
	it("invokes onTick on every fake-timer interval", async () => {
		const onTick = vi.fn();
		let intervalFn: (() => void) | undefined;
		const setInt = vi.fn((fn: () => void) => {
			intervalFn = fn;
			return { id: 42 };
		});
		installRefreshTimer({
			backends: [backend("a", "resolved")],
			isIdle: () => true,
			onTick,
			setInterval: setInt,
			clearInterval: () => {},
		});
		// Simulate two ticks.
		intervalFn?.();
		await Promise.resolve();
		intervalFn?.();
		await Promise.resolve();
		expect(onTick).toHaveBeenCalledTimes(2);
	});

	it("defers onTick when isIdle() returns false, then fires when it returns true", async () => {
		const onTick = vi.fn();
		let intervalFn: (() => void) | undefined;
		const setInt = vi.fn((fn: () => void) => {
			intervalFn = fn;
			return { id: 43 };
		});
		let idle = false;
		installRefreshTimer({
			backends: [backend("a", "resolved")],
			isIdle: () => idle,
			onTick,
			setInterval: setInt,
			clearInterval: () => {},
		});
		intervalFn?.();
		await Promise.resolve();
		expect(onTick).not.toHaveBeenCalled();
		idle = true;
		intervalFn?.();
		await Promise.resolve();
		expect(onTick).toHaveBeenCalledTimes(1);
	});

	it("swallows errors from onTick and retries on next tick", async () => {
		let intervalFn: (() => void) | undefined;
		const setInt = vi.fn((fn: () => void) => {
			intervalFn = fn;
			return { id: 44 };
		});
		let count = 0;
		const onTick = vi.fn(async () => {
			count++;
			if (count === 1) throw new Error("boom");
		});
		installRefreshTimer({
			backends: [backend("a", "resolved")],
			isIdle: () => true,
			onTick,
			setInterval: setInt,
			clearInterval: () => {},
		});
		intervalFn?.();
		await Promise.resolve();
		await Promise.resolve();
		intervalFn?.();
		await Promise.resolve();
		expect(onTick).toHaveBeenCalledTimes(2);
	});
});

describe("installRefreshTimer — stop", () => {
	it("stop() calls clearInterval with the timer handle", () => {
		const handleObj = { id: "timer-handle" };
		const clearInt = vi.fn();
		const timer = installRefreshTimer({
			backends: [backend("a", "resolved")],
			isIdle: () => true,
			onTick: () => {},
			setInterval: () => handleObj,
			clearInterval: clearInt,
		});
		timer.stop();
		expect(clearInt).toHaveBeenCalledWith(handleObj);
	});
	it("stop() on a non-installed timer is a no-op", () => {
		const clearInt = vi.fn();
		const timer = installRefreshTimer({
			backends: [backend("a", "static")],
			isIdle: () => true,
			onTick: () => {},
			setInterval: () => ({}),
			clearInterval: clearInt,
		});
		timer.stop();
		expect(clearInt).not.toHaveBeenCalled();
	});
});
