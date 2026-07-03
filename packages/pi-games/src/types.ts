/**
 * Shared types for pi-games extension.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface GameDef {
	id: string;
	name: string;
	description: string;
	icon: string;
	createComponent(
		tui: { requestRender: () => void },
		theme: any,
		onExit: (result: GameResult) => void,
		highScore: number,
		onScoreUpdate?: (score: number) => void
	): GameComponent;
}

export interface GameComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export interface GameResult {
	score: number;
}

export interface ScoreEntry {
	gameId: string;
	score: number;
	date: number;
}

export interface ScoresState {
	scores: ScoreEntry[];
}
