/**
 * High score persistence via pi.appendEntry.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScoresState, ScoreEntry } from "./types.js";

const SCORES_ENTRY_TYPE = "pi-games-scores";

export function loadScores(ctx: ExtensionContext): ScoresState {
	const state: ScoresState = { scores: [] };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === SCORES_ENTRY_TYPE) {
			const data = entry.data as ScoresState;
			if (data?.scores) {
				state.scores = data.scores;
			}
		}
	}
	return state;
}

export function saveScores(pi: ExtensionAPI, state: ScoresState): void {
	pi.appendEntry(SCORES_ENTRY_TYPE, state);
}

export function getHighScore(state: ScoresState, gameId: string): number {
	let high = 0;
	for (const entry of state.scores) {
		if (entry.gameId === gameId && entry.score > high) {
			high = entry.score;
		}
	}
	return high;
}

export function recordScore(
	pi: ExtensionAPI,
	state: ScoresState,
	gameId: string,
	score: number
): boolean {
	const prev = getHighScore(state, gameId);
	const entry: ScoreEntry = { gameId, score, date: Date.now() };
	state.scores.push(entry);
	saveScores(pi, state);
	return score > prev && score > 0;
}
