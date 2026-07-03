# pi-status

Context bar compositor and LLM environment injector for [Pi](https://github.com/earendil-works/pi-coding-agent). Owns the context-bar widget at the top of the TUI, renders live session info, and injects a small environment block into the system prompt before each agent run.

I built this because Pi's default status display was minimal, and I kept needing to check the model, token usage, and git branch manually while working. This pulls all of that into one persistent bar that other extensions can also write into.

## Install

```bash
pi install npm:@pedro_klein/pi-status
```

## What it provides

- **Context bar widget** — persistent TUI bar showing model, token usage, I/O stats, thinking level, and git branch
- **External segment API** — other extensions register and update named segments in the bar via pi events
- **LLM environment injection** — appends git branch, context percentage, and worktree warning to every agent system prompt
- **Footer** — renders cwd, keybinding hints, and any extension status messages at the bottom of the TUI
- **Title** — keeps the terminal title updated with model, mode (if pi-modes is active), and git branch

## Context Bar Segments

Built-in segments render in priority order (highest first):

| Segment | Priority | Shows |
|---------|----------|-------|
| `_model` | 90 | Current model name (shortened) |
| `_tokens` | 80 | Token usage bar + percentage + count |
| `_io` | 70 | Cumulative session input/output tokens and cost |
| `_thinking` | 60 | Thinking level with color coding |
| `_branch` | 10 | Current git branch |

## External Segment API

Other extensions can add or update segments in the context bar using Pi's event system:

```typescript
// Register a new segment (call once at setup)
pi.events.emit("pi-status:register", {
  id: "my-segment",      // unique ID
  priority: 50,          // higher = further left; default 50
  render: (theme) => theme.fg("muted", "my text"),
});

// Update an existing segment's content
pi.events.emit("pi-status:update", {
  id: "my-segment",
  render: (theme) => theme.fg("accent", "updated text"),
});

// Remove a segment
pi.events.emit("pi-status:update", {
  id: "my-segment",
  render: null,
});
```

The `render` function receives the Pi theme object and returns a string (with ANSI color via `theme.fg(color, text)`).

Priority controls left-to-right ordering: `_model` (90) is leftmost, `_branch` (10) is rightmost. External segments default to priority 50 (between `_io` and `_thinking`).

## LLM Environment Injection

Before each agent run, pi-status appends to the system prompt:

```
Git branch: main
Context: 24% used (48k/200k tokens)
```

If multiple worktrees are active, a warning is added:

```
⚠ 3 worktrees active — verify correct worktree before making changes.
```

This keeps the model aware of where it is without you having to say it.

## Configuration

No configuration required — works out of the box.

The extension automatically skips itself when running inside a Pi subagent process (`PI_SUBAGENT_DEPTH > 0`) to avoid duplicate status bars in nested agent runs.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
