/**
 * Maps pi key event data to terminal escape sequences for PTY forwarding.
 *
 * Pi's handleInput receives raw terminal data strings. Most printable characters
 * and standard escape sequences pass through directly. We need special handling
 * for keys that pi normalizes or that need translation.
 */

import { matchesKey, Key } from "@earendil-works/pi-tui";

/**
 * Check if a key event matches a pi keybinding string like "ctrl+shift+g".
 * Uses pi's built-in matchesKey for consistency.
 */
export function matchesPiKey(data: string, keyCombo: string): boolean {
	return matchesKey(data, keyCombo);
}

/**
 * Convert pi key data to the bytes to write to the PTY.
 * Most raw terminal input passes through directly — pi's handleInput
 * receives the actual terminal escape sequences for special keys.
 *
 * Returns null only if the key should be swallowed (not forwarded).
 */
export function toTerminalSequence(data: string): string | null {
	// Raw data from the terminal is already the correct escape sequence
	// for most keys. Pi's handleInput gets the raw bytes.
	// We just pass them through to the PTY.
	return data;
}

/**
 * Parse a keybinding string like "ctrl+c" into the terminal byte to generate.
 * Used for programmatic key sending, not for handleInput forwarding.
 */
export function keyComboToSequence(combo: string): string | null {
	const parts = combo.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	const hasCtrl = parts.includes("ctrl");
	const hasAlt = parts.includes("alt");
	const hasShift = parts.includes("shift");

	if (hasCtrl && key && key.length === 1 && key >= "a" && key <= "z") {
		const code = key.charCodeAt(0) - 96; // ctrl+a = 1, ctrl+z = 26
		const char = String.fromCharCode(code);
		return hasAlt ? `\x1b${char}` : char;
	}

	// Special keys
	const specialMap: Record<string, string> = {
		enter: "\r",
		return: "\r",
		tab: "\t",
		escape: "\x1b",
		esc: "\x1b",
		backspace: "\x7f",
		delete: "\x1b[3~",
		space: " ",
		up: "\x1b[A",
		down: "\x1b[B",
		right: "\x1b[C",
		left: "\x1b[D",
		home: "\x1b[H",
		end: "\x1b[F",
		pageup: "\x1b[5~",
		pagedown: "\x1b[6~",
		insert: "\x1b[2~",
		f1: "\x1bOP",
		f2: "\x1bOQ",
		f3: "\x1bOR",
		f4: "\x1bOS",
		f5: "\x1b[15~",
		f6: "\x1b[17~",
		f7: "\x1b[18~",
		f8: "\x1b[19~",
		f9: "\x1b[20~",
		f10: "\x1b[21~",
		f11: "\x1b[23~",
		f12: "\x1b[24~",
	};

	if (key && specialMap[key]) {
		let seq = specialMap[key];
		// Shift/Ctrl/Alt modifiers for special keys use CSI modifier format
		if ((hasShift || hasCtrl || hasAlt) && seq.startsWith("\x1b[") && !seq.startsWith("\x1bO")) {
			const mod = 1 + (hasShift ? 1 : 0) + (hasAlt ? 2 : 0) + (hasCtrl ? 4 : 0);
			// Convert \x1b[A → \x1b[1;modA, \x1b[5~ → \x1b[5;mod~
			if (seq.length === 3 && seq[2] !== "~") {
				seq = `\x1b[1;${mod}${seq[2]}`;
			} else {
				const tilde = seq.endsWith("~");
				const num = seq.slice(2, tilde ? -1 : undefined);
				seq = `\x1b[${num};${mod}${tilde ? "~" : ""}`;
			}
		} else if (hasAlt && seq.length === 1) {
			seq = `\x1b${seq}`;
		}
		return seq;
	}

	// Plain character with alt
	if (hasAlt && !hasCtrl && key && key.length === 1) {
		return `\x1b${hasShift ? key.toUpperCase() : key}`;
	}

	// Plain character
	if (!hasCtrl && !hasAlt && key && key.length === 1) {
		return hasShift ? key.toUpperCase() : key;
	}

	return null;
}
