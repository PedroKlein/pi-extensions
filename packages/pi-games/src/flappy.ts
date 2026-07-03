/**
 * Flappy Bird — terminal clone for pi-games.
 *
 * Space/Up to flap. Gravity pulls the bird down. Navigate through pipe gaps.
 * Score = pipes passed.
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { GameDef, GameComponent, GameResult } from "./types.js";

const TICK_MS = 33;
const GRAVITY = 0.18;
const FLAP_FORCE = -1.3;
const PIPE_SPEED = 0.35;
const PIPE_WIDTH = 4;
const PIPE_GAP = 7;
const PIPE_SPACING = 25;
const BIRD_COL = 10;

interface Pipe {
	x: number;
	gapTop: number; // top of the gap
	scored: boolean;
}

interface FlappyState {
	birdY: number;
	velocity: number;
	pipes: Pipe[];
	score: number;
	gameOver: boolean;
	started: boolean;
	frameCount: number;
	highScore: number;
	fieldWidth: number;
	fieldHeight: number;
}

function createPipe(x: number, fieldHeight: number): Pipe {
	const minTop = 2;
	const maxTop = fieldHeight - PIPE_GAP - 2;
	const gapTop = minTop + Math.floor(Math.random() * (maxTop - minTop));
	return { x, gapTop, scored: false };
}

function createState(fieldWidth: number, fieldHeight: number, highScore: number): FlappyState {
	return {
		birdY: Math.floor(fieldHeight / 2),
		velocity: 0,
		pipes: [createPipe(fieldWidth, fieldHeight)],
		score: 0,
		gameOver: false,
		started: false,
		frameCount: 0,
		highScore,
		fieldWidth,
		fieldHeight,
	};
}

class FlappyComponent implements GameComponent {
	private state: FlappyState;
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
		this.state = createState(40, 15, highScore);
	}

	private startGame(): void {
		this.state.started = true;
		this.state.velocity = FLAP_FORCE;
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
		s.frameCount++;

		// Physics
		s.velocity += GRAVITY;
		s.birdY += s.velocity;

		// Ceiling / floor
		if (s.birdY < 0) {
			s.birdY = 0;
			s.velocity = 0;
		}
		if (s.birdY >= s.fieldHeight) {
			s.gameOver = true;
			if (s.score > s.highScore) s.highScore = s.score;
			this.reportScore(s.score);
			this.stopTimer();
			return;
		}

		// Move pipes
		for (const pipe of s.pipes) {
			pipe.x -= PIPE_SPEED;
		}

		// Remove off-screen pipes
		s.pipes = s.pipes.filter((p) => p.x + PIPE_WIDTH > -1);

		// Spawn new pipes
		const lastPipe = s.pipes[s.pipes.length - 1];
		if (!lastPipe || lastPipe.x < s.fieldWidth - PIPE_SPACING) {
			s.pipes.push(createPipe(s.fieldWidth, s.fieldHeight));
		}

		// Scoring
		for (const pipe of s.pipes) {
			if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_COL) {
				pipe.scored = true;
				s.score++;
				if (s.score > s.highScore) s.highScore = s.score;
				this.reportScore(s.score);
			}
		}

		// Collision
		const birdRow = Math.round(s.birdY);
		for (const pipe of s.pipes) {
			const pipeLeft = Math.round(pipe.x);
			const pipeRight = pipeLeft + PIPE_WIDTH;
			if (BIRD_COL + 2 > pipeLeft && BIRD_COL < pipeRight) {
				if (birdRow < pipe.gapTop || birdRow >= pipe.gapTop + PIPE_GAP) {
					s.gameOver = true;
					if (s.score > s.highScore) s.highScore = s.score;
					this.reportScore(s.score);
					this.stopTimer();
					return;
				}
			}
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
			if (matchesKey(data, "space") || matchesKey(data, "up") || data === "w" || data === "W") {
				this.startGame();
			}
			return;
		}

		if (this.state.gameOver) {
			if (data === "r" || data === "R" || matchesKey(data, "space")) {
				this.stopTimer();
				this.state = createState(this.state.fieldWidth, this.state.fieldHeight, this.bestThisSession);
				this.startGame();
				this.version++;
				this.tui.requestRender();
			}
			return;
		}

		// Flap
		if (matchesKey(data, "space") || matchesKey(data, "up") || data === "w" || data === "W") {
			this.state.velocity = FLAP_FORCE;
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
		const effectiveWidth = Math.min(s.fieldWidth, Math.floor((width - 4) / cellWidth));
		const boxWidth = effectiveWidth * cellWidth;

		const dim = (t: string) => theme.fg("dim", t);
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
		const title = `${bold(warning("FLAPPY BIRD"))} │ Score: ${bold(warning(String(s.score)))} │ High: ${bold(warning(String(s.highScore)))}`;
		lines.push(padLine(boxLine(title)));
		lines.push(padLine(dim(` ├${"─".repeat(boxWidth)}┤`)));

		// Game grid
		const birdRow = Math.round(s.birdY);
		for (let y = 0; y < s.fieldHeight; y++) {
			let row = "";
			for (let x = 0; x < effectiveWidth; x++) {
				// Is bird here?
				if (x === BIRD_COL && y === birdRow) {
					row += warning("◄►");
					continue;
				}

				// Is pipe here?
				let isPipe = false;
				for (const pipe of s.pipes) {
					const pLeft = Math.round(pipe.x);
					if (x >= pLeft && x < pLeft + PIPE_WIDTH) {
						if (y < pipe.gapTop || y >= pipe.gapTop + PIPE_GAP) {
							isPipe = true;
							// Pipe edge
							if (y === pipe.gapTop - 1 || y === pipe.gapTop + PIPE_GAP) {
								row += success("▓▓");
							} else {
								row += success("██");
							}
							break;
						}
					}
				}
				if (!isPipe) {
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
			footer = `Press ${bold("Space")} or ${bold("↑")} to start`;
		} else if (s.gameOver) {
			footer = `${error(bold("GAME OVER!"))} ${bold("R")} restart · ${bold("Q")} quit`;
		} else {
			footer = `${bold("Space")} or ${bold("↑")} flap · ${bold("Q")} quit`;
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

export const flappyGame: GameDef = {
	id: "flappy",
	name: "Flappy Bird",
	description: "Navigate through pipes by flapping",
	icon: "🐦",
	createComponent(tui, theme, onExit, highScore, onScoreUpdate) {
		return new FlappyComponent(tui, theme, onExit, highScore, onScoreUpdate);
	},
};
