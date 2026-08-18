import { describe, expect, it } from "vitest";

import { isPrintableChar, ListView, TextInput } from "../src/tui-widgets.js";

describe("ListView — navigation + scrolling", () => {
	const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);

	it("clamps the cursor at both ends (no wrap)", () => {
		const lv = new ListView(items);
		lv.move(-1);
		expect(lv.cursor).toBe(0);
		lv.move(100);
		expect(lv.cursor).toBe(9);
		expect(lv.current()).toBe("item-9");
	});

	it("window keeps the cursor visible and reports overflow", () => {
		const lv = new ListView(items);
		// Top of a 4-row window.
		let w = lv.window(4);
		expect(w.items).toEqual(["item-0", "item-1", "item-2", "item-3"]);
		expect(w.cursorRow).toBe(0);
		expect(w.hasAbove).toBe(false);
		expect(w.hasBelow).toBe(true);

		// Move past the window bottom → offset follows.
		lv.moveTo(5);
		w = lv.window(4);
		expect(w.items).toEqual(["item-2", "item-3", "item-4", "item-5"]);
		expect(w.cursorRow).toBe(3);
		expect(w.hasAbove).toBe(true);
		expect(w.hasBelow).toBe(true);

		// Bottom.
		lv.moveTo(9);
		w = lv.window(4);
		expect(w.items).toEqual(["item-6", "item-7", "item-8", "item-9"]);
		expect(w.cursorRow).toBe(3);
		expect(w.hasBelow).toBe(false);
	});

	it("filters by case-insensitive substring and clamps the cursor", () => {
		const lv = new ListView(["Alpha", "beta", "Gamma", "alps"]);
		lv.moveTo(3);
		lv.setFilter("al");
		expect(lv.filtered()).toEqual(["Alpha", "alps"]);
		expect(lv.cursor).toBe(1); // clamped to new length-1
		lv.clearFilter();
		expect(lv.filtered()).toHaveLength(4);
	});

	it("current() is undefined when the filter matches nothing", () => {
		const lv = new ListView(items);
		lv.setFilter("zzz");
		expect(lv.filtered()).toEqual([]);
		expect(lv.current()).toBeUndefined();
		const w = lv.window(4);
		expect(w.items).toEqual([]);
	});

	it("appendFilter/backspaceFilter edit the needle", () => {
		const lv = new ListView(["gpt-5", "gpt-5-mini", "claude"]);
		lv.appendFilter("g");
		lv.appendFilter("p");
		expect(lv.filtered()).toEqual(["gpt-5", "gpt-5-mini"]);
		lv.backspaceFilter();
		lv.backspaceFilter();
		expect(lv.filter).toBe("");
	});
});

describe("ListView — multi-select", () => {
	it("toggles membership and preserves insertion order", () => {
		const lv = new ListView(["a", "b", "c", "d"]);
		lv.moveTo(2);
		lv.toggleSelected(); // c
		lv.toggleSelected("a");
		lv.toggleSelected("d");
		expect(lv.selected()).toEqual(["c", "a", "d"]);
		expect(lv.isSelected("a")).toBe(true);
		lv.toggleSelected("a"); // remove
		expect(lv.selected()).toEqual(["c", "d"]);
	});

	it("seeds selection from constructor and setSelected", () => {
		const lv = new ListView(["a", "b"], { selected: ["b"] });
		expect(lv.selected()).toEqual(["b"]);
		lv.setSelected(["a", "b"]);
		expect(lv.selected()).toEqual(["a", "b"]);
	});
});

describe("TextInput", () => {
	it("inserts printable text and tracks the caret", () => {
		const t = new TextInput();
		t.insert("groq");
		expect(t.value).toBe("groq");
		expect(t.caret).toBe(4);
	});

	it("backspaces and deletes within bounds", () => {
		const t = new TextInput("abc");
		t.backspace();
		expect(t.value).toBe("ab");
		t.home();
		t.del();
		expect(t.value).toBe("b");
		t.backspace(); // caret at 0 — no-op
		expect(t.value).toBe("b");
	});

	it("moves the caret and inserts mid-string", () => {
		const t = new TextInput("ac");
		t.left();
		t.insert("b");
		expect(t.value).toBe("abc");
		t.end();
		expect(t.caret).toBe(3);
	});

	it("set() and clear()", () => {
		const t = new TextInput("x");
		t.set("hello");
		expect(t.value).toBe("hello");
		expect(t.caret).toBe(5);
		t.clear();
		expect(t.value).toBe("");
		expect(t.caret).toBe(0);
	});
});

describe("isPrintableChar", () => {
	it("accepts single printable chars, rejects control/multi-byte sequences", () => {
		expect(isPrintableChar("a")).toBe(true);
		expect(isPrintableChar("5")).toBe(true);
		expect(isPrintableChar(" ")).toBe(true);
		expect(isPrintableChar("\x1b[A")).toBe(false); // arrow up
		expect(isPrintableChar("\r")).toBe(false);
		expect(isPrintableChar("\x7f")).toBe(false); // DEL
		expect(isPrintableChar("")).toBe(false);
	});
});
