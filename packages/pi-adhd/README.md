# pi-adhd

Sticky notes, side-chat, and reminders for [Pi](https://github.com/mariozechner/pi-coding-agent).

You know how you're deep in a conversation with the agent, and you think "oh, I should ask it to generate ADRs at the end" but you don't want to inject that now? This is for that. Capture the thought, keep working, inject it later.

## Features

### Sticky notes

Session-scoped notes that live outside the LLM context window. The agent never sees them until you explicitly inject one.

Three categories:
- `prompt` - actions to take later (injected as a user message, triggers an agent turn)
- `reminder` - things to not forget (never injected, just for you)
- `reference` - context to remember (injected as passive context)

AI classification picks the category automatically when you add a note. You can override it.

Two-column TUI with vim keybindings lets you browse, edit, inject, delete, or pin notes.

### Side chat

A floating conversation overlay for quick questions. Replaces the standalone `btw` extension.

- Streaming responses with model picker (Ctrl+L to cycle)
- Template modes: `/btw compact` summarizes your main conversation as context
- 5 exit actions: discard, inject, summarize+inject, steer, save as note
- No tools, just a simple LLM chat

### Reminders

The status bar shows `🧠 3 notes` whenever you have pending notes. After 8 assistant turns without you looking at them, it appends `⚡` and fires a toast notification so you don't forget.

When you close the session, an overlay shows any orphan notes (not pinned, not injected) and lets you pin them before they disappear.

## Installation

Add to your Pi `settings.json`:

```json
{
  "packages": ["git:github.com/PedroKlein/pi-adhd"]
}
```

Pi clones the repo and builds it automatically.

## Commands and shortcuts

| Command | Shortcut | What it does |
|---------|----------|--------------|
| `/note` | `Ctrl+Shift+N` | Open notes TUI |
| `/note <text>` | | Add a note (AI classify, preview form, confirm) |
| `/btw` | `Ctrl+Alt+B` | Open blank side-chat |
| `/btw compact` | | Side-chat with main conversation context |
| `/btw explain` | | Context + "Explain what you're doing" |
| `/btw why` | | Context + "Why did you choose this approach?" |
| `/btw help` | | Context + "What should I know?" |

## Notes TUI keybindings

| Key | Action |
|-----|--------|
| `j/k` or arrows | Navigate |
| `Enter` | Inject selected note |
| `e` | Edit note content |
| `c` | Cycle category |
| `d` | Delete |
| `p` | Pin to project (survives sessions) |
| `P` | Pin globally |
| `Esc` / `q` | Close |

## Configuration

In Pi's `settings.json`:

```json
{
  "pi-adhd": {
    "reminderTurns": 8
  }
}
```

`reminderTurns` controls how many assistant turns pass before the reminder fires. Default is 8.

## How it works

**Adding a note:** `/note generate ADRs for auth decisions` runs AI classification (BAML if available, LLM otherwise, heuristic fallback), shows a preview form, you confirm.

**Remembering:** Note sits in memory. Status bar shows the count. After 8 turns, it nudges you.

**Using it:** Open the TUI, pick a note, press Enter. Prompt notes get injected as a user message (the agent responds). Reference notes get injected as context (the agent sees it silently). Reminder notes can't be injected at all.

**Pinning:** Notes are ephemeral by default. Press `p` to save to `~/.pi/adhd/<org-repo>.json` (project-scoped) or `P` for `~/.pi/adhd/global.json`. Pinned notes reload next session.

## Optional integrations

If [pi-baml](https://github.com/PedroKlein/pi-baml) is installed, pi-adhd uses it for structured note classification via inline BAML (no `.baml` files needed). Otherwise it calls the LLM directly or falls back to a simple heuristic (everything defaults to "prompt").

To install pi-baml alongside:
```json
{
  "packages": [
    "git:github.com/PedroKlein/pi-baml",
    "git:github.com/PedroKlein/pi-adhd"
  ]
}
```

No hard dependencies on any other extension. pi-adhd works fine without pi-baml.

## License

MIT
