import { describe, expect, it } from "vitest";

import defaultExport, { EXTENSION_NAME } from "../src/index.js";

describe("pi-gateway scaffold", () => {
	it("has the expected extension name", () => {
		expect(EXTENSION_NAME).toBe("pi-gateway");
	});

	it("exports a default function that takes an ExtensionAPI", () => {
		expect(typeof defaultExport).toBe("function");
		expect(defaultExport.length).toBe(1);
	});

	it("registers session_start, message_end, and session_shutdown handlers", () => {
		const registered: Array<{ event: string }> = [];
		const commands: string[] = [];
		const fakeApi = {
			on: (event: string) => {
				registered.push({ event });
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as Parameters<typeof defaultExport>[0];
		defaultExport(fakeApi);
		expect(registered.map((r) => r.event).sort()).toEqual(
			["message_end", "session_shutdown", "session_start"].sort(),
		);
	});
});
