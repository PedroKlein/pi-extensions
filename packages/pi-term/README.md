# pi-term

Floating terminal panel inside pi's TUI. Launch shells, TUI tools, or any CLI program in an overlay without leaving your agent session.

I built this because switching windows while pi is working breaks my flow. With pi-term, I can run `lazygit`, a shell, or `htop` right inside the pi interface — and close it when I'm done.

## Install

```bash
pi install npm:@pedroklein/pi-term
```

> **Note:** `node-pty` requires native compilation. If install fails, make sure you have a C++ build toolchain (`xcode-select --install` on macOS, `build-essential` on Linux).

## What it provides

- **Command `/term`** — launch, pick from a list, or run an ad-hoc command
- **Shortcuts** — per-app keybindings registered at session start
- **Widget `/term keys`** — shows active keybindings in the context bar

## Commands

| Command | Description |
|---------|-------------|
| `/term` | Open app picker |
| `/term <name>` | Launch app by name |
| `/term -- <cmd>` | Run any command in a floating terminal |
| `/term keys` | Toggle keybinding overlay in context bar |

## How it works

Each app opens as an overlay on top of pi's TUI. It's a real PTY — full color, interactive shells, curses apps, everything works. Press the configured close key (default `ctrl+q`) to dismiss.

Apps can be toggled (show/hide without killing the process) or one-shot (close on exit). Conditional apps (`if` field) are checked lazily at launch time so startup stays fast.

When a command exits, you can optionally:
- Get a notification with exit code
- Feed the command's output as context to the agent (`feedContext`)

## Configuration

Create `~/.pi/agent/pi-term.json` for global apps, or `.pi/pi-term.json` in any project for project-local apps. Both are merged — project-local wins on name collisions.

```json
{
  "defaults": {
    "width": "80%",
    "height": "80%",
    "anchor": "center",
    "shell": "/bin/zsh",
    "closeKey": "ctrl+q",
    "holdOnExit": false,
    "toggle": false,
    "notify": false,
    "borderColor": "accent"
  },
  "apps": [
    {
      "name": "shell",
      "cmd": "$SHELL",
      "key": "ctrl+shift+t",
      "toggle": true
    },
    {
      "name": "lazygit",
      "cmd": "lazygit",
      "key": "ctrl+shift+g",
      "if": "command -v lazygit",
      "width": "95%",
      "height": "95%"
    },
    {
      "name": "htop",
      "cmd": "htop",
      "notify": true,
      "feedContext": "echo 'Process check complete'"
    }
  ]
}
```

### App fields

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Display name and `/term <name>` identifier |
| `cmd` | required | Command to run. Use `$SHELL` for an interactive shell |
| `key` | — | Keybinding to toggle/launch (e.g. `ctrl+shift+t`) |
| `width` | `"80%"` | Overlay width — percentage or absolute columns |
| `height` | `"80%"` | Overlay height — percentage or absolute rows |
| `anchor` | `"center"` | Overlay position: `center`, `top`, `bottom`, `left`, `right` |
| `closeKey` | `"ctrl+q"` | Key to close the overlay |
| `shell` | `$SHELL` | Shell used to run `cmd` |
| `toggle` | `false` | If true, re-pressing the key hides/shows instead of reopening |
| `holdOnExit` | `false` | Keep overlay open after the process exits |
| `notify` | `false` | Show exit code notification when process exits |
| `feedContext` | — | Shell command whose stdout is sent to the agent after exit |
| `if` | — | Condition checked before launching; skips if non-zero exit |
| `cwd` | session cwd | Working directory for the process |
| `env` | — | Extra environment variables |
| `borderColor` | `"accent"` | Border color (any pi theme color) |

### Defaults

All app fields except `name` and `cmd` fall back to the `defaults` block. Override defaults globally, then tweak per-app only what's different.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
