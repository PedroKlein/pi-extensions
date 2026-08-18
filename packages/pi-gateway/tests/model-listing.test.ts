import { describe, expect, it } from "vitest";

import { listBackendModels, listRegistryProviders } from "../src/index.js";

const registry = {
	getAll: () => [
		{ id: "gpt-5", provider: "openrouter" },
		{ id: "claude-opus", provider: "openrouter" },
		{ id: "gpt-5", provider: "openrouter" }, // duplicate id
		{ id: "cop-a", provider: "github-copilot" },
		{ id: "anthropic--claude-4.8-opus", provider: "sap-ai-core" },
	],
};

describe("listBackendModels", () => {
	it("returns exactly the backend's model ids, sorted + de-duped", () => {
		expect(listBackendModels(registry, "openrouter")).toEqual(["claude-opus", "gpt-5"]);
		expect(listBackendModels(registry, "github-copilot")).toEqual(["cop-a"]);
		expect(listBackendModels(registry, "unknown")).toEqual([]);
	});

	it("tolerates a registry without getAll", () => {
		expect(listBackendModels({}, "openrouter")).toEqual([]);
	});
});

describe("listRegistryProviders", () => {
	it("returns unique provider names, sorted", () => {
		expect(listRegistryProviders(registry)).toEqual(["github-copilot", "openrouter", "sap-ai-core"]);
	});
});
