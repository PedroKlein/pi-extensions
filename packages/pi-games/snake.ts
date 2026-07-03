/**
 * Snake — terminal clone for pi-games.
 *
 * Arrow keys / WASD to move. Eat food to grow. Don't hit walls or yourself.
 * Score = food eaten × 10.
 */

import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { GameDef, GameComponent, GameResult } from "./types.js";

const TICK_MS = 100;
const FIELD_WIDTH = 40;
const FIELD_HEIGHT = 15;

type Direction = "up" | "down" | "left" | "right";
type Point = { x: number; y: number };

interface SnakeState {
	snake: Point[];
	food: Point;
	direction: Direction;
	nextDirection: Direction;
	score: number;
	gameOver: boolean;
	started: boolean;
	highScore: number;
}

function spawnFood(snake: Point[]): Point {
	let food: Point;
	do {
		food = {
			x: Math.floor(Math.random() * FIELD_WIDTH),
			y: Math.floor(Math.random() * FIELD_HEIGHT),
		};
	} while (snake.some((s) => s.x === food.x && s.y === food.y));
	return food;
}

function createState(highScore: number): SnakeState {
	const startX = Math.floor(FIELD_WIDTH / 2);
	const startY = Math.floor(FIELD_HEIGHT / 2);
	const snake = [
		{ x: startX, y: startY },
		{ x: startX - 1, y: startY },
		{ x: startX - 2, y: startY },
	];
	return {
		snake,
		food: spawnFood(snake),
		direction: "right",
		nextDirection: "right",
		score: 0,
		gameOver: false,
		started: false,
		highScore,
	};
}

class SnakeComponent implements GameComponent {
	private state: SnakeState;
	private interval: ReturnType<typeof setInterval> | null = null;
	private onExit: (result: GameResult) => void;
	private onScoreUpdate: ((score: number) => void) | undefined;
	private tui: { requestRender: () => void };
	private theme: any;
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;
	private bestThisSession: number;

	constructor(
		tui: { requestRender: () => void },
		theme: any,
		onExit: (result: GameResult) => void,
		highScore: number,
		onScoreUpdate?: (score: number) => void
	) {
		this.tui = tui;
		this.theme = theme;
		this.onExit = onExit;
		this.onScoreUpdate = onScoreUpdate;
		this.bestThisSession = highScore;
		this.state = createState(highScore);
	}

	private startGame(): void {
		this.state.started = true;
		this.interval = setInterval(() => {
			if (!this.state.gameOver) {
				this.tick();
				this.version++;
				this.tui.requestRender();
			}
		}, TICK_MS);
	}

	private tick(): void {
		const s = this.state;
		s.direction = s.nextDirection;

		const head = s.snake[0];
		let newHead: Point;
		switch (s.direction) {
			case "up":    newHead = { x: head.x, y: head.y - 1 }; break;
			case "down":  newHead = { x: head.x, y: head.y + 1 }; break;
			case "left":  newHead = { x: head.x - 1, y: head.y }; break;
			case "right": newHead = { x: head.x + 1, y: head.y }; break;
		}

		// Wall collision
		if (newHead.x < 0 || newHead.x >= FIELD_WIDTH || newHead.y < 0 || newHead.y >= FIELD_HEIGHT) {
			s.gameOver = true;
			if (s.score > s.highScore) s.highScore = s.score;
			this.reportScore(s.score);
			this.stopTimer();
			return;
		}

		// Self collision
		if (s.snake.some((seg) => seg.x === newHead.x && seg.y === newHead.y)) {
			s.gameOver = true;
			if (s.score > s.highScore) s.highScore = s.score;
			this.reportScore(s.score);
			this.stopTimer();
			return;
		}

		s.snake.unshift(newHead);

		// Food
		if (newHead.x === s.food.x && newHead.y === s.food.y) {
			s.score += 10;
			if (s.score > s.highScore) s.highScore = s.score;
			this.reportScore(s.score);
			s.food = spawnFood(s.snake);
		} else {
			s.snake.pop();
		}
	}

	private stopTimer(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private reportScore(score: number): void {
		if (score > this.bestThisSession) {
			this.bestThisSession = score;
			this.onScoreUpdate?.(score);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.dispose();
			this.onExit({ score: this.bestThisSession });
			return;
		}

		if (!this.state.started) {
			// Any direction key starts the game
			if (
				matchesKey(data, "up") || matchesKey(data, "down") ||
				matchesKey(data, "left") || matchesKey(data, "right") ||
				"wasdWASD".includes(data)
			) {
				this.startGame();
				// Also apply the direction
				this.applyDirection(data);
			}
			return;
		}

		if (this.state.gameOver) {
			if (data === "r" || data === "R" || matchesKey(data, "space")) {
				this.stopTimer();
				this.state = createState(this.bestThisSession);
				this.startGame();
				this.version++;
				this.tui.requestRender();
			}
			return;
		}

		this.applyDirection(data);
	}

	private applyDirection(data: string): void {
		const s = this.state;
		if ((matchesKey(data, "up") || data === "w" || data === "W") && s.direction !== "down") {
			s.nextDirection = "up";
		} else if ((matchesKey(data, "down") || data === "s" || data === "S") && s.direction !== "up") {
			s.nextDirection = "down";
		} else if ((matchesKey(data, "left") || data === "a" || data === "A") && s.direction !== "right") {
			s.nextDirection = "left";
		} else if ((matchesKey(data, "right") || data === "d" || data === "D") && s.direction !== "left") {
			s.nextDirection = "right";
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const s = this.state;
		const theme = this.theme;
		const cellWidth = 2;
		const effectiveWidth = Math.min(FIELD_WIDTH, Math.floor((width - 4) / cellWidth));
		const boxWidth = effectiveWidth * cellWidth;

		const dim = (t: string) => theme.fg("dim", t);
		const accent = (t: string) => theme.fg("accent", t);
		const success = (t: string) => theme.fg("success", t);
		const error = (t: string) => theme.fg("error", t);
		const warning = (t: string) => theme.fg("warning", t);
		const bold = (t: string) => theme.bold(t);

		const padLine = (line: string) => {
			const vis = visibleWidth(line);
			const pad = Math.max(0, width - vis);
			return line + " ".repeat(pad);
		};

		const boxLine = (content: string) => {
			const contentLen = visibleWidth(content);
			const padding = Math.max(0, boxWidth - contentLen);
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		const lines: string[] = [];

		// Top border
		lines.push(padLine(dim(` ╭${"─".repeat(boxWidth)}╮`)));

		// Header
		const title = `${bold(success("SNAKE"))} │ Score: ${bold(warning(String(s.score)))} │ High: ${bold(warning(String(s.highScore)))}`;
		lines.push(padLine(boxLine(title)));
		lines.push(padLine(dim(` ├${"─".repeat(boxWidth)}┤`)));

		// Game grid
		for (let y = 0; y < FIELD_HEIGHT; y++) {
			let row = "";
			for (let x = 0; x < effectiveWidth; x++) {
				const isHead = s.snake[0].x === x && s.snake[0].y === y;
				const isBody = s.snake.slice(1).some((seg) => seg.x === x && seg.y === y);
				const isFood = s.food.x === x && s.food.y === y;

				if (isHead) {
					row += success("██");
				} else if (isBody) {
					row += success("▓▓");
				} else if (isFood) {
					row += error("◆ ");
				} else {
					row += "  ";
				}
			}
			lines.push(padLine(dim(" │") + row + dim("│")));
		}

		// Separator
		lines.push(padLine(dim(` ├${"─".repeat(boxWidth)}┤`)));

		// Footer
		let footer: string;
		if (!s.started) {
			footer = `Press ${bold("↑↓←→")} or ${bold("WASD")} to start`;
		} else if (s.gameOver) {
			footer = `${error(bold("GAME OVER!"))} ${bold("R")} restart · ${bold("Q")} quit`;
		} else {
			footer = `${bold("↑↓←→")} or ${bold("WASD")} move · ${bold("Q")} quit`;
		}
		lines.push(padLine(boxLine(footer)));
		lines.push(padLine(dim(` ╰${"─".repeat(boxWidth)}╯`)));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}

	dispose(): void {
		this.stopTimer();
	}
}

export const snakeGame: GameDef = {
	id: "snake",
	name: "Snake",
	description: "Eat food to grow, don't hit yourself",
	icon: "🐍",
	createComponent(tui, theme, onExit, highScore, onScoreUpdate) {
		return new SnakeComponent(tui, theme, onExit, highScore, onScoreUpdate);
	},
};
