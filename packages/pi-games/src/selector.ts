/**
 * Game selector — centered overlay modal listing available games.
 *
 * j/k or ↑/↓ navigate, Enter to launch, Esc to close.
 * Shows name, description, icon, and high score for each game.
 */

import { matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameDef, GameResult } from "./types.js";
import type { ScoresState } from "./types.js";
import { getHighScore } from "./scores.js";

export interface SelectorResult {
	action: "play";
	gameId: string;
}

export async function showGameSelector(
	ctx: ExtensionContext,
	games: GameDef[],
	scores: ScoresState
): Promise<SelectorResult | null> {
	return ctx.ui.custom<SelectorResult | null>(
		(_tui, theme, _kb, done) => {
			let selectedIndex = 0;
			let cachedLines: string[] | undefined;

			function invalidate() {
				cachedLines = undefined;
			}

			function pad(s: string, len: number): string {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, len - vis));
			}

			function row(content: string, contentW: number): string {
				const fitted =
					visibleWidth(content) > contentW
						? truncateToWidth(content, contentW)
						: pad(content, contentW);
				return theme.fg("accent", "│") + " " + fitted + " " + theme.fg("accent", "│");
			}

			function emptyRow(contentW: number): string {
				return row("", contentW);
			}

			function handleInput(data: string) {
				if (matchesKey(data, "escape") || data === "q") {
					done(null);
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					if (selectedIndex > 0) selectedIndex--;
				} else if (matchesKey(data, "down") || data === "j") {
					if (selectedIndex < games.length - 1) selectedIndex++;
				} else if (matchesKey(data, "enter")) {
					done({ action: "play", gameId: games[selectedIndex].id });
				}
				invalidate();
				_tui.requestRender();
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const contentW = width - 4;
				const lines: string[] = [];

				// Top border
				const titleText = " 🎮 Games ";
				const titleLen = visibleWidth(titleText);
				const leftDash = 1;
				const rightDash = Math.max(1, width - 2 - titleLen - leftDash);
				lines.push(
					theme.fg("accent", "╭" + "─".repeat(leftDash)) +
					theme.fg("accent", theme.bold(titleText)) +
					theme.fg("accent", "─".repeat(rightDash) + "╮")
				);

				lines.push(emptyRow(contentW));

				// Game entries
				for (let i = 0; i < games.length; i++) {
					const game = games[i];
					const selected = i === selectedIndex;
					const prefix = selected ? theme.fg("accent", "▸ ") : "  ";

					const highScore = getHighScore(scores, game.id);
					const scoreText = highScore > 0
						? theme.fg("warning", ` [best: ${highScore}]`)
						: "";

					const name = selected
						? theme.fg("accent", theme.bold(`${game.icon} ${game.name}`))
						: `${game.icon} ${game.name}`;

					lines.push(row(prefix + name + scoreText, contentW));

					const desc = selected
						? theme.fg("accent", `    ${game.description}`)
						: theme.fg("dim", `    ${game.description}`);
					lines.push(row(desc, contentW));

					if (i < games.length - 1) {
						lines.push(emptyRow(contentW));
					}
				}

				lines.push(emptyRow(contentW));

				// Hints
				const hints = "↑↓ navigate · Enter play · Esc close";
				lines.push(row(theme.fg("dim", "  " + hints), contentW));

				// Bottom border
				lines.push(theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

				cachedLines = lines;
				return lines;
			}

			return { render, invalidate, handleInput };
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as any,
				width: "50%",
				minWidth: 40,
				maxHeight: "60%",
			},
		}
	);
}
