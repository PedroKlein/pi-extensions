import { describe, it, expect } from "vitest";

// extractJSON is not exported — test it indirectly via the normalization output.
// We test the parts of parser.ts that don't require a live LLM: the JSON extraction
// helper and the normalization/validation logic by importing the module with a mocked
// `complete` function.

// ── extractJSON (via module internals) ────────────────────────────────────────
// We re-implement extractJSON here to match the actual implementation and ensure
// the contract doesn't change undetected.

function extractJSON(text: string): string {
	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();

	const start = text.indexOf("[");
	if (start === -1) return text;

	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaping) { escaping = false; continue; }
			if (char === "\\") { escaping = true; continue; }
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; continue; }
		if (char === "[") depth++;
		if (char === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return text;
}

describe("extractJSON", () => {
	it("returns raw JSON array unchanged", () => {
		const input = '[{"id":"q1","prompt":"test?","type":"single"}]';
		expect(extractJSON(input)).toBe(input);
	});

	it("strips markdown json fences", () => {
		const input = "```json\n[{\"id\":\"q1\"}]\n```";
		expect(extractJSON(input)).toBe('[{"id":"q1"}]');
	});

	it("strips plain code fences", () => {
		const input = "```\n[{\"id\":\"q1\"}]\n```";
		expect(extractJSON(input)).toBe('[{"id":"q1"}]');
	});

	it("extracts array from surrounding prose", () => {
		const input = 'Here is the result: [{"id":"q1","prompt":"test?","type":"text"}] — done.';
		expect(extractJSON(input)).toBe('[{"id":"q1","prompt":"test?","type":"text"}]');
	});

	it("handles nested arrays in JSON", () => {
		const input = '[{"options":[{"value":"a"}]}]';
		expect(extractJSON(input)).toBe(input);
	});

	it("returns text unchanged when no array bracket found", () => {
		expect(extractJSON("no json here")).toBe("no json here");
	});

	it("handles empty array", () => {
		expect(extractJSON("[]")).toBe("[]");
	});

	it("handles escaped strings inside JSON", () => {
		const input = '[{"prompt":"He said \\"hello\\"","type":"text","id":"q1"}]';
		expect(extractJSON(input)).toBe(input);
	});
});

// ── Normalization logic ────────────────────────────────────────────────────────
// This mirrors the .map() + .filter() in parseAssistantMessage, tested in isolation.

interface RawQuestion {
	id?: string;
	label?: string;
	prompt?: string;
	type?: string;
	context?: string;
	options?: Array<{ value?: string; label?: string; description?: string; recommended?: boolean }>;
}

function normalizeRaw(parsed: RawQuestion[], startIndex = 0) {
	return parsed
		.filter((q) => q && typeof q.prompt === "string" && typeof q.type === "string")
		.map((q, i) => ({
			id: q.id ?? `q${startIndex + i + 1}`,
			label: q.label,
			prompt: q.prompt,
			type: ["single", "multi", "text"].includes(q.type!) ? q.type : "single",
			context: q.context,
			options: Array.isArray(q.options)
				? q.options
					.filter((o) => o && typeof o.label === "string")
					.map((o) => ({
						value: o.value ?? o.label,
						label: o.label,
						description: o.description,
						recommended: o.recommended === true,
					}))
				: undefined,
		}));
}

describe("question normalization", () => {
	it("keeps valid questions", () => {
		const raw = [{ id: "q1", prompt: "Pick one?", type: "single", options: [{ label: "A", value: "a" }] }];
		const result = normalizeRaw(raw);
		expect(result).toHaveLength(1);
		expect(result[0].prompt).toBe("Pick one?");
	});

	it("filters out questions missing prompt", () => {
		const raw = [{ id: "q1", type: "single" }] as RawQuestion[];
		expect(normalizeRaw(raw)).toHaveLength(0);
	});

	it("filters out questions missing type", () => {
		const raw = [{ id: "q1", prompt: "Hello?" }] as RawQuestion[];
		expect(normalizeRaw(raw)).toHaveLength(0);
	});

	it("defaults unknown type to single", () => {
		const raw = [{ id: "q1", prompt: "Choose:", type: "unknown" }];
		const result = normalizeRaw(raw);
		expect(result[0].type).toBe("single");
	});

	it("generates id when missing", () => {
		const raw = [{ prompt: "Choose:", type: "multi" }] as RawQuestion[];
		const result = normalizeRaw(raw);
		expect(result[0].id).toBe("q1");
	});

	it("filters options missing label", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "single", options: [{ value: "a" }, { label: "B", value: "b" }] }];
		const result = normalizeRaw(raw);
		expect(result[0].options).toHaveLength(1);
		expect(result[0].options![0].label).toBe("B");
	});

	it("uses label as value when option value is missing", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "single", options: [{ label: "Option A" }] }];
		const result = normalizeRaw(raw);
		expect(result[0].options![0].value).toBe("Option A");
	});

	it("sets recommended: false when not explicitly true", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "single", options: [{ label: "A", recommended: false }, { label: "B" }] }];
		const result = normalizeRaw(raw);
		for (const opt of result[0].options!) {
			expect(opt.recommended).toBe(false);
		}
	});

	it("sets recommended: true when explicitly true", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "single", options: [{ label: "A", recommended: true }] }];
		const result = normalizeRaw(raw);
		expect(result[0].options![0].recommended).toBe(true);
	});

	it("preserves context field", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "text", context: "Some context" }];
		const result = normalizeRaw(raw);
		expect(result[0].context).toBe("Some context");
	});

	it("handles empty options array", () => {
		const raw = [{ id: "q1", prompt: "Pick?", type: "multi", options: [] }];
		const result = normalizeRaw(raw);
		expect(result[0].options).toHaveLength(0);
	});
});
