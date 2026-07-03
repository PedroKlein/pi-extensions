import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Terminal } from "@xterm/headless";
import * as pty from "node-pty";
import type { ResolvedApp } from "./config.js";
import { toTerminalSequence } from "./keys.js";

const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

interface TerminalOverlayOptions {
	tui: TUI;
	theme: any;
	done: (exitCode: number | null) => void;
	app: ResolvedApp;
}

export class TerminalOverlay implements Component {
	private tui: TUI;
	private theme: any;
	private doneCb: (exitCode: number | null) => void;
	private app: ResolvedApp;
	private doneCalledAlready = false;

	private ptyProcess: pty.IPty | null = null;
	private xterm: Terminal;
	cols: number;
	rows: number;

	private cachedLines: string[] | null = null;
	private lastWidth: number = 0;

	private exited = false;
	private exitCode: number | null = null;
	private spawnError: string | null = null;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;

	constructor(options: TerminalOverlayOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.doneCb = options.done;
		this.app = options.app;

		this.cols = 80;
		this.rows = 24;

		this.xterm = new Terminal({
			cols: this.cols,
			rows: this.rows,
			allowProposedApi: true,
			logLevel: "off",
		});
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		const shell = this.app.shell;
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			...(this.app.env ?? {}),
		};

		try {
			const cmd = this.app.cmd;
			// If the command is just $SHELL or the shell itself, spawn directly
			// as an interactive shell — no "-c" wrapper which creates two
			// nested shells and causes terminal control conflicts.
			const isShellCmd =
				cmd === "$SHELL" ||
				cmd === shell ||
				cmd === process.env.SHELL;

			if (isShellCmd) {
				this.ptyProcess = pty.spawn(shell, [], {
					name: "xterm-256color",
					cols: this.cols,
					rows: this.rows,
					cwd: this.app.cwd || process.cwd(),
					env,
				});
			} else {
				this.ptyProcess = pty.spawn(shell, ["-c", cmd], {
					name: "xterm-256color",
					cols: this.cols,
					rows: this.rows,
					cwd: this.app.cwd || process.cwd(),
					env,
				});
			}

			this.ptyProcess.onData((data: string) => {
				this.xterm.write(data);
				this.scheduleRender();
			});

			// Pipe terminal responses (device attributes, etc.) back to PTY.
			// IMPORTANT: Defer writes to next tick to prevent synchronous feedback loops.
			// Interactive shells (zsh, bash) continuously query terminal state,
			// and writing responses synchronously during xterm.write() can
			// starve the event loop.
			let pendingResponse = "";
			let responseScheduled = false;
			this.xterm.onData((data: string) => {
				pendingResponse += data;
				if (!responseScheduled) {
					responseScheduled = true;
					setImmediate(() => {
						responseScheduled = false;
						if (this.ptyProcess && !this.exited && pendingResponse) {
							this.ptyProcess.write(pendingResponse);
							pendingResponse = "";
						}
					});
				}
			});

			this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
				this.exited = true;
				this.exitCode = exitCode;
				this.scheduleRender();
			});
		} catch (err: any) {
			this.exited = true;
			this.exitCode = 1;
			this.spawnError = err.message;
			this.scheduleRender();
		}
	}

	private closeSafe(): void {
		if (this.doneCalledAlready) return;
		this.doneCalledAlready = true;
		this.kill();
		this.doneCb(this.exitCode);
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			this.cachedLines = null;
			this.tui.requestRender();
		}, 16);
	}

	handleInput(data: string): void {
		if (matchesKey(data, this.app.closeKey)) {
			this.closeSafe();
			return;
		}
		if (this.app.key && matchesKey(data, this.app.key)) {
			this.closeSafe();
			return;
		}
		if (this.exited) {
			this.closeSafe();
			return;
		}
		if (this.ptyProcess && !this.exited) {
			const seq = toTerminalSequence(data);
			if (seq !== null) {
				this.ptyProcess.write(seq);
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.lastWidth === width) {
			return this.cachedLines;
		}
		this.lastWidth = width;
		const innerWidth = Math.max(width - 2, 1);

		if (innerWidth !== this.cols && innerWidth > 0) {
			this.cols = innerWidth;
			try {
				this.xterm.resize(this.cols, this.rows);
				if (this.ptyProcess) this.ptyProcess.resize(this.cols, this.rows);
			} catch {
				// ignore
			}
		}

		const bc = (s: string) => this.theme.fg(this.app.borderColor, s);
		const lines: string[] = [];

		// Title bar
		const title = ` ${this.app.name} `;
		const hint = ` ${this.app.closeKey} `;
		const fill = Math.max(width - 2 - visibleWidth(title) - visibleWidth(hint), 0);
		lines.push(
			truncateToWidth(
				bc(BOX.topLeft + BOX.horizontal) +
					this.theme.bold(title) +
					bc(BOX.horizontal.repeat(fill)) +
					this.theme.fg("dim", hint) +
					bc(BOX.horizontal + BOX.topRight),
				width,
			),
		);

		// Terminal rows
		if (this.spawnError) {
			lines.push(truncateToWidth(bc(BOX.vertical) + this.theme.fg("error", ` Error: ${this.spawnError}`), width));
			for (let i = 1; i < this.rows; i++) {
				lines.push(bc(BOX.vertical) + " ".repeat(innerWidth) + bc(BOX.vertical));
			}
		} else {
			const buffer = this.xterm.buffer.active;
			const cursorY = buffer.cursorY;
			const cursorX = buffer.cursorX;
			const showCursor = !this.exited;

			for (let row = 0; row < this.rows; row++) {
				const bufLine = buffer.getLine(row);
				const rowStr = bufLine
					? this.renderLine(bufLine, innerWidth, showCursor && row === cursorY ? cursorX : -1)
					: " ".repeat(innerWidth);
				lines.push(bc(BOX.vertical) + rowStr + bc(BOX.vertical));
			}
		}

		// Bottom bar
		let status = "";
		let statusLen = 0;
		if (this.exited) {
			const code = String(this.exitCode ?? "?");
			const color = this.exitCode === 0 ? "success" : "error";
			status = this.theme.fg(color, ` exit:${code} `) + this.theme.fg("dim", "press any key ");
			statusLen = visibleWidth(status);
		}
		const bFill = Math.max(width - 2 - statusLen, 0);
		lines.push(truncateToWidth(bc(BOX.bottomLeft + BOX.horizontal.repeat(bFill)) + status + bc(BOX.bottomRight), width));

		this.cachedLines = lines;
		return lines;
	}

	/**
	 * Render a single buffer line with colors and optional cursor.
	 * Returns a string of exactly `maxWidth` visible characters.
	 */
	private renderLine(line: any, maxWidth: number, cursorCol: number): string {
		let result = "";
		let col = 0;
		const reusableCell = line.getCell(0);
		if (!reusableCell) return " ".repeat(maxWidth);

		let lastSgr = "";

		for (let i = 0; i < line.length && col < maxWidth; i++) {
			line.getCell(i, reusableCell);
			const w = reusableCell.getWidth();
			if (w === 0) continue; // wide char continuation

			const chars = reusableCell.getChars() || " ";
			const isCursorHere = cursorCol === i;

			// Build SGR sequence for this cell
			const sgr = this.cellSgr(reusableCell, isCursorHere);
			if (sgr !== lastSgr) {
				result += "\x1b[0m" + sgr;
				lastSgr = sgr;
			}

			result += chars;
			col += w;
		}

		// Reset styles
		result += "\x1b[0m";

		// Pad to maxWidth if line is shorter
		if (col < maxWidth) {
			// If cursor is past the end of content, show it
			if (cursorCol >= col && cursorCol < maxWidth) {
				const padBefore = cursorCol - col;
				result += " ".repeat(padBefore);
				result += "\x1b[7m \x1b[0m"; // inverse space for cursor
				result += " ".repeat(maxWidth - cursorCol - 1);
			} else {
				result += " ".repeat(maxWidth - col);
			}
		}

		return result;
	}

	/**
	 * Build an SGR escape sequence from cell attributes.
	 */
	private cellSgr(cell: any, inverse: boolean): string {
		const parts: number[] = [];

		if (cell.isBold()) parts.push(1);
		if (cell.isDim()) parts.push(2);
		if (cell.isItalic()) parts.push(3);
		if (cell.isUnderline()) parts.push(4);
		if (inverse || cell.isInverse()) parts.push(7);

		if (!cell.isFgDefault()) {
			const fg = cell.getFgColor();
			if (cell.isFgPalette()) {
				parts.push(38, 5, fg);
			} else if (fg >= 0) {
				parts.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
			}
		}

		if (!cell.isBgDefault()) {
			const bg = cell.getBgColor();
			if (cell.isBgPalette()) {
				parts.push(48, 5, bg);
			} else if (bg >= 0) {
				parts.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
			}
		}

		return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
	}

	invalidate(): void {
		this.cachedLines = null;
	}

	kill(): void {
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		if (this.ptyProcess && !this.exited) {
			try {
				this.ptyProcess.kill();
			} catch {
				// ignore
			}
		}
	}

	resize(cols: number, rows: number): void {
		if (cols === this.cols && rows === this.rows) return;
		this.cols = cols;
		this.rows = rows;
		try {
			this.xterm.resize(cols, rows);
			if (this.ptyProcess) this.ptyProcess.resize(cols, rows);
		} catch {
			// ignore
		}
		this.invalidate();
	}

	isExited(): boolean {
		return this.exited;
	}

	getExitCode(): number | null {
		return this.exitCode;
	}
}
