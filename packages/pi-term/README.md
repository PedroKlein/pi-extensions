# Pi-Term Extension

Launch TUI applications in floating terminal overlays inside pi. Run lazygit, k9s, nvim, or any terminal command without leaving your agent session.

## Features

- **Floating overlays** — apps render in bordered, resizable overlays with full color/cursor support
- **Keyboard shortcuts** — bind apps to key combos for instant toggle access
- **Toggle mode** — press the same shortcut again to hide/show a persistent app
- **Conditional apps** — only show apps when their binary exists (`if` field)
- **Feed context** — run a command on exit and send its output back to the agent
- **Ad-hoc commands** — run any command with `/term -- <command>`
- **App picker** — `/term` with no args shows a fuzzy picker of all configured apps

## Configuration

Two config files, merged with local overrides taking priority:

| File | Scope |
|------|-------|
| `~/.pi/agent/pi-term.json` | Global defaults and apps |
| `<project>/.pi/pi-term.json` | Project-specific overrides |

### Config Structure

```json
{
  "defaults": {
    "width": "95%",
    "height": "95%",
    "anchor": "center",
    "closeKey": "ctrl+q",
    "holdOnExit": false,
    "toggle": false,
    "notify": false,
    "borderColor": "accent"
  },
  "apps": [
    {
      "name": "lazygit",
      "key": "ctrl+shift+g",
      "cmd": "lazygit",
      "width": "90%",
      "height": "85%",
      "notify": true,
      "feedContext": "git log --oneline -3"
    }
  ]
}
```

### App Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | *required* | Display name and identifier |
| `cmd` | string | *required* | Shell command to run |
| `key` | string | — | Keyboard shortcut (e.g. `ctrl+shift+g`) |
| `width` | string | from defaults | Overlay width (`"90%"` or pixel count) |
| `height` | string | from defaults | Overlay height |
| `anchor` | string | `"center"` | Overlay position |
| `closeKey` | string | `"ctrl+q"` | Key to close the overlay |
| `cwd` | string | project dir | Working directory |
| `env` | object | — | Extra environment variables |
| `shell` | string | `$SHELL` | Shell to use for command execution |
| `toggle` | boolean | `false` | Keep process alive when hidden, toggle with same key |
| `holdOnExit` | boolean | `false` | Keep overlay open after process exits |
| `notify` | boolean | `false` | Show notification on exit |
| `feedContext` | string | — | Shell command to run on exit; stdout is sent to the agent |
| `borderColor` | string | `"accent"` | Border color (theme color name) |
| `if` | string | — | Condition command; app only available if exit code is 0 |

## Configured Apps

| App | Shortcut | Description |
|-----|----------|-------------|
| lazygit | `Ctrl+Shift+G` | Git TUI with context feedback (last 3 commits) |
| lazydocker | `Ctrl+Shift+D` | Docker management (conditional: requires lazydocker) |
| k9s | `Ctrl+Shift+K` | Kubernetes management (conditional: requires k9s) |
| nvim | `Ctrl+Shift+E` | Neovim editor in overlay |
| terminal | `` Ctrl+` `` | Toggle-mode shell session |

## Commands

| Command | Description |
|---------|-------------|
| `/term` | Show app picker |
| `/term <name>` | Launch app by name |
| `/term -- <command>` | Run arbitrary command in overlay |
| `/term keys` | Toggle keybinding reference widget |

## How It Works

Each app spawns a real PTY process (via `node-pty`) and renders through `@xterm/headless`. Terminal output is translated to pi's TUI rendering system with full SGR color support, cursor display, and proper resize handling. The overlay is drawn with a bordered frame showing the app name and close key hint.

When `feedContext` is set, the specified command runs after the app exits and its stdout is injected into the agent conversation — useful for feeding git state back after a lazygit session.

## Architecture

```
index.ts              — Extension entry: commands, shortcuts, lifecycle
config.ts             — Config loading, merging (global + local), app resolution
terminal-component.ts — PTY + xterm.js rendering, overlay frame, input handling
keys.ts               — Key event translation for PTY forwarding
```

## Dependencies

- `node-pty` — Native PTY bindings for spawning terminal processes
- `@xterm/headless` — Headless xterm.js for terminal state management
