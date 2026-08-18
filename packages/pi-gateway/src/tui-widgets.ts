/**
 * Framework-agnostic TUI state helpers.
 *
 * Pure state models (no pi-tui import, no I/O) so the editor's list navigation
 * and text entry are unit-testable without a terminal. Rendering lives in the
 * component; these only own cursor/scroll/selection/caret math.
 */

/**
 * A scrollable, filterable list with optional multi-select. `cursor` indexes
 * into the *filtered* view; `window(rows)` yields the visible slice and keeps
 * the cursor in view. Selection is tracked by value in insertion order so a
 * multi-select tier keeps the user's chosen model order.
 */
export class ListView {
	private _items: string[];
	private _cursor = 0;
	private _offset = 0;
	private _filter = "";
	private _selected: string[];

	constructor(items: string[] = [], opts: { selected?: string[] } = {}) {
		this._items = [...items];
		this._selected = opts.selected ? [...opts.selected] : [];
	}

	get filter(): string {
		return this._filter;
	}

	get cursor(): number {
		return this._cursor;
	}

	/** Replace the backing items (e.g. after a reload); clamps the cursor. */
	setItems(items: string[]): void {
		this._items = [...items];
		this.clampCursor();
	}

	/** Items passing the current filter (case-insensitive substring). */
	filtered(): string[] {
		if (this._filter === "") return [...this._items];
		const needle = this._filter.toLowerCase();
		return this._items.filter((i) => i.toLowerCase().includes(needle));
	}

	/** The highlighted item, or undefined when the filtered list is empty. */
	current(): string | undefined {
		return this.filtered()[this._cursor];
	}

	/** Move the cursor by delta, clamped to the filtered list bounds. */
	move(delta: number): void {
		const n = this.filtered().length;
		if (n === 0) {
			this._cursor = 0;
			return;
		}
		this._cursor = Math.min(n - 1, Math.max(0, this._cursor + delta));
	}

	moveTo(index: number): void {
		const n = this.filtered().length;
		this._cursor = n === 0 ? 0 : Math.min(n - 1, Math.max(0, index));
	}

	setFilter(filter: string): void {
		this._filter = filter;
		this.clampCursor();
	}

	appendFilter(ch: string): void {
		this.setFilter(this._filter + ch);
	}

	backspaceFilter(): void {
		if (this._filter.length > 0) this.setFilter(this._filter.slice(0, -1));
	}

	clearFilter(): void {
		this.setFilter("");
	}

	/** Toggle selection of a value (defaults to the current item). */
	toggleSelected(value?: string): void {
		const v = value ?? this.current();
		if (v === undefined) return;
		const i = this._selected.indexOf(v);
		if (i >= 0) this._selected.splice(i, 1);
		else this._selected.push(v);
	}

	isSelected(value: string): boolean {
		return this._selected.includes(value);
	}

	/** Selected values in insertion (== display) order. */
	selected(): string[] {
		return [...this._selected];
	}

	setSelected(values: string[]): void {
		this._selected = [...values];
	}

	/**
	 * The visible window of `rows` items, adjusting the scroll offset so the
	 * cursor stays in view. `cursorRow` is the cursor's index within `items`.
	 */
	window(rows: number): {
		items: string[];
		startIndex: number;
		cursorRow: number;
		hasAbove: boolean;
		hasBelow: boolean;
	} {
		const list = this.filtered();
		const n = list.length;
		if (rows <= 0 || n === 0) {
			return { items: [], startIndex: 0, cursorRow: 0, hasAbove: false, hasBelow: false };
		}
		if (this._cursor < this._offset) this._offset = this._cursor;
		else if (this._cursor >= this._offset + rows) this._offset = this._cursor - rows + 1;
		this._offset = Math.max(0, Math.min(this._offset, Math.max(0, n - rows)));
		const end = Math.min(n, this._offset + rows);
		return {
			items: list.slice(this._offset, end),
			startIndex: this._offset,
			cursorRow: this._cursor - this._offset,
			hasAbove: this._offset > 0,
			hasBelow: end < n,
		};
	}

	private clampCursor(): void {
		const n = this.filtered().length;
		this._cursor = n === 0 ? 0 : Math.min(Math.max(0, this._cursor), n - 1);
	}
}

/** A single-line text buffer with a caret. Used for rename/add/number entry. */
export class TextInput {
	private _value: string;
	private _caret: number;

	constructor(initial = "") {
		this._value = initial;
		this._caret = initial.length;
	}

	get value(): string {
		return this._value;
	}

	get caret(): number {
		return this._caret;
	}

	insert(s: string): void {
		this._value = this._value.slice(0, this._caret) + s + this._value.slice(this._caret);
		this._caret += s.length;
	}

	backspace(): void {
		if (this._caret > 0) {
			this._value = this._value.slice(0, this._caret - 1) + this._value.slice(this._caret);
			this._caret--;
		}
	}

	del(): void {
		if (this._caret < this._value.length) {
			this._value = this._value.slice(0, this._caret) + this._value.slice(this._caret + 1);
		}
	}

	left(): void {
		if (this._caret > 0) this._caret--;
	}

	right(): void {
		if (this._caret < this._value.length) this._caret++;
	}

	home(): void {
		this._caret = 0;
	}

	end(): void {
		this._caret = this._value.length;
	}

	set(value: string): void {
		this._value = value;
		this._caret = value.length;
	}

	clear(): void {
		this._value = "";
		this._caret = 0;
	}
}

/**
 * Whether a raw key `data` string is a single printable character (not a
 * control/escape sequence). Lets the editor route typing into filters and text
 * inputs while leaving navigation keys alone.
 */
export function isPrintableChar(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.codePointAt(0)!;
	return code >= 0x20 && code !== 0x7f;
}
