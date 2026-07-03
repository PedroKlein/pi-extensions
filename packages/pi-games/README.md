# pi-games

Something to do while Pi works on your code. Snake and Flappy Bird as centered TUI overlays, with high scores that persist across sessions.

## Install

```bash
pi install npm:@pedroklein/pi-games
```

## What it provides

**Commands:**

| Command | Action |
|---------|--------|
| `/game` | Open the game selector — returns to selector after each game |
| `/game snake` | Launch Snake directly |
| `/game flappy` | Launch Flappy Bird directly |

Tab completion works: `/game ` shows available games with icons.

## Available Games

### 🐍 Snake

Eat food to grow. Don't hit walls or yourself.

| Key | Action |
|-----|--------|
| `↑↓←→` or `WASD` | Move (also starts the game) |
| `R` / `Space` | Restart after game over |
| `Q` / `Esc` | Quit |

Score = food eaten × 10. 100ms tick.

### 🐦 Flappy Bird

Navigate through pipe gaps. Gravity pulls the bird down; flap to push back up.

| Key | Action |
|-----|--------|
| `Space` / `↑` / `W` | Flap (also starts the game) |
| `R` / `Space` | Restart after game over |
| `Q` / `Esc` | Quit |

Score = pipes passed. 33ms tick (~30fps) for smooth physics.

## High Scores

Scores are persisted per session using pi's `appendEntry` mechanism — they survive conversation compaction and are available as long as the session is open. The selector shows your best score for each game. A toast notification fires when you beat your high score.

Scores do not persist across sessions. Each new pi session starts fresh.

## Configuration

No configuration required — works out of the box.

## How it works

Games render as overlay modals on top of the conversation. Game state and messages are filtered from LLM context, so playing a game doesn't pollute the agent's conversation history.

`/game` enters a selector loop — after each game ends, you're returned to the selector. `/game snake` or `/game flappy` launches directly and exits to the terminal on quit.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

To add a new game, implement `GameDef` from `src/types.ts` and add it to the `GAMES` array in `src/index.ts`.

## License

MIT
