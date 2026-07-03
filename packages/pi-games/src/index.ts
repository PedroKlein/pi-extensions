/**
 * pi-games — Play games while the agent runs.
 *
 * /game          — Open game selector
 * /game flappy   — Play Flappy Bird directly
 * /game snake    — Play Snake directly
 *
 * Games run as centered overlay modals. High scores are persisted per session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameDef, GameResult, ScoresState } from "./types.js";
import { flappyGame } from "./flappy.js";
import { snakeGame } from "./snake.js";
import { loadScores, getHighScore, recordScore } from "./scores.js";
import { showGameSelector } from "./selector.js";

const GAMES: GameDef[] = [flappyGame, snakeGame];

export default function piGames(pi: ExtensionAPI) {
	let scores: ScoresState = { scores: [] };

	// ── Load scores on session start ──────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		scores = loadScores(ctx);
	});

	// ── Filter game messages from LLM context ─────────────────────────────

	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter((m: any) => {
			if (m.role === "custom" && typeof m.customType === "string" && m.customType.startsWith("pi-games-")) {
				return false;
			}
			return true;
		});
		return { messages: filtered };
	});

	// ── /game command ─────────────────────────────────────────────────────

	pi.registerCommand("game", {
		description: "Play a game: /game (selector), /game flappy, /game snake",
		getArgumentCompletions: (prefix: string) => {
			const items = GAMES.map((g) => ({ value: g.id, label: `${g.icon} ${g.name}` }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/game requires interactive mode", "error");
				return;
			}

			const gameId = (args ?? "").trim().toLowerCase();

			if (gameId) {
				// Direct launch
				const game = GAMES.find((g) => g.id === gameId);
				if (!game) {
					ctx.ui.notify(`Unknown game: "${gameId}". Available: ${GAMES.map((g) => g.id).join(", ")}`, "error");
					return;
				}
				await launchGame(game, ctx, false);
			} else {
				// Selector loop: after a game ends, go back to selector
				await selectorLoop(ctx);
			}
		},
	});

	// ── Selector loop ─────────────────────────────────────────────────────

	async function selectorLoop(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const result = await showGameSelector(ctx, GAMES, scores);
			if (!result) return; // Esc pressed

			const game = GAMES.find((g) => g.id === result.gameId);
			if (!game) return;

			await launchGame(game, ctx, true);
		}
	}

	// ── Launch a game ─────────────────────────────────────────────────────

	async function launchGame(game: GameDef, ctx: ExtensionContext, returnToSelector: boolean): Promise<void> {
		const highScore = getHighScore(scores, game.id);

		const result = await ctx.ui.custom<GameResult>(
			(tui, theme, _kb, done) => {
				const onScoreUpdate = (score: number) => {
					recordScore(pi, scores, game.id, score);
				};
				const component = game.createComponent(tui, theme, done, highScore, onScoreUpdate);
				return {
					render: (w: number) => component.render(w),
					invalidate: () => component.invalidate(),
					handleInput: (data: string) => component.handleInput(data),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as any,
					width: 84,
				},
			}
		);

		// Final score save on exit (covers edge case where score wasn't reported live)
		if (result && result.score > 0) {
			const isNew = recordScore(pi, scores, game.id, result.score);
			if (isNew) {
				ctx.ui.notify(`🏆 New high score in ${game.name}: ${result.score}!`, "info");
			}
		}
	}
}
