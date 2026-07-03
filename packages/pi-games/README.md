# pi-games

Play games while the agent runs. Centered overlay modals with high score tracking.

## Features

- **Game selector**: Centered overlay listing available games with high scores
- **Direct launch**: `/game flappy` or `/game snake` to skip the selector
- **Tab completion**: `/game ` shows available games
- **High scores**: Persisted per session via `appendEntry`, shown in selector and game headers
- **Live score tracking**: Scores saved as you play, not just on exit
- **New high score notification**: Toast when you beat your best
- **Context filtering**: Game messages never enter LLM context

## Games

### 🐦 Flappy Bird

Navigate through pipe gaps by flapping. Gravity pulls you down, space/↑ gives you a boost.

| Key | Action |
|-----|--------|
| `Space` / `↑` / `W` | Flap (also starts the game) |
| `R` | Restart (on game over) |
| `Q` / `Esc` | Quit |

- 33ms tick (~30fps) for smooth physics
- Score = pipes passed
- Pipes rendered with gap edges (`▓▓`) and bodies (`██`)
- Bird rendered as `◄►`

### 🐍 Snake

Eat food to grow. Don't hit walls or yourself.

| Key | Action |
|-----|--------|
| `↑↓←→` / `WASD` | Move (also starts the game) |
| `R` / `Space` | Restart (on game over) |
| `Q` / `Esc` | Quit |

- 100ms tick
- Score = food eaten × 10
- Snake head `██`, body `▓▓`, food `◆`

## Commands

| Command | Action |
|---------|--------|
| `/game` | Open game selector (returns to selector after each game) |
| `/game flappy` | Play Flappy Bird directly |
| `/game snake` | Play Snake directly |

## Adding a New Game

1. Create `my-game.ts` implementing `GameDef` from `types.ts`:

```typescript
import type { GameDef, GameComponent, GameResult } from "./types.js";

export const myGame: GameDef = {
  id: "mygame",
  name: "My Game",
  description: "Short description",
  icon: "🎯",
  createComponent(tui, theme, onExit, highScore, onScoreUpdate) {
    return new MyGameComponent(tui, theme, onExit, highScore, onScoreUpdate);
  },
};
```

2. Add it to the `GAMES` array in `index.ts`:

```typescript
import { myGame } from "./my-game.js";
const GAMES: GameDef[] = [flappyGame, snakeGame, myGame];
```

The `GameComponent` interface:
- `render(width): string[]` — render the game at the given width
- `handleInput(data): void` — handle keyboard input
- `invalidate(): void` — clear render cache
- `dispose?(): void` — cleanup timers on exit

Call `onScoreUpdate(score)` during gameplay to persist scores live. Call `onExit({ score })` with `bestThisSession` when quitting.

## Architecture

```
index.ts      Entry point: /game command, selector loop, game launcher, score wiring
selector.ts   Game picker overlay with high scores
flappy.ts     Flappy Bird game component
snake.ts      Snake game component
scores.ts     High score persistence via appendEntry
types.ts      GameDef, GameComponent, GameResult, ScoresState interfaces
```

## Design Decisions

- **Overlay modals** — games render on top of conversation, don't replace the screen
- **Selector loop** — `/game` returns to selector after each game; direct launch exits to terminal
- **Live score persistence** — `onScoreUpdate` callback fires on each new high score, not just on exit
- **`bestThisSession` tracking** — games track best score across restarts within one session, ensuring accurate reporting even after multiple R-restarts
- **No context pollution** — game messages filtered from LLM context via `context` event handler
- **Consistent visual style** — both games use `dim` borders, `theme.fg` colors, double-width cells (`██`) for square appearance
- **Theme-aware rendering** — all colors via `theme.fg()`, adapts to any pi theme
