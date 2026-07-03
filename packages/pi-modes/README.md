# pi-modes

A 5-mode workflow system for Pi. Each mode controls which tools the agent can use, what it can write, and how it reasons — enforced at the extension layer, not by prompting alone.

I built this because I wanted distinct operating modes with hard guarantees: a read-only investigation mode that can't accidentally write files, a brainstorm mode that stays in thinking territory, a plan mode that won't execute, and a build mode that has full access when I'm ready for it.

## Install

```bash
pi install npm:@pedroklein/pi-modes
```

Also install [`@pedroklein/pi-readonly-bash`](https://github.com/PedroKlein/pi-extensions/tree/main/packages/pi-readonly-bash) — the read-only modes swap `bash` for `bash_readonly`, which requires that extension to be present.

## What it provides

**Keybindings:**
- `Ctrl+Alt+M` — cycle through modes in order: Ask → Brainstorm → Plan → Build → None → Ask

**Events emitted:**
- `pi-modes:changed` — fired on every mode switch with `{ mode, previousMode }`
- `pi-status:register` — updates the status bar segment (integrates with `@pedroklein/pi-status`)

**Events consumed:**
- `pi-ask:mode-switch` — switches mode programmatically from an `ask_user` action (integrates with `@pedroklein/pi-ask`)

**Prompts:** ships mode-specific system prompt fragments in `prompts/`. Each prompt is injected into the system prompt when that mode is active.

## Modes

| Mode | Icon | Access | Purpose |
|------|------|--------|---------|
| **Ask** | ❓ | Read-only | Investigation, diagnosis, evidence gathering |
| **Brainstorm** | 💡 | Read-only | Active thinking partner — trade-offs, alternatives |
| **Plan** | 📋 | Read-only + planning tools | Task graph structuring, TDD breakdown |
| **Build** | 🔨 | Full access | Implementation, execution, reporting |
| **None** | ⊘ | Full access, no injection | Raw Pi — zero constraints from this extension |

## Tool gating

In **Ask**, **Brainstorm**, and **Plan** modes:
- `bash` is removed from the tool list; `bash_readonly` takes its place
- Mutating subagents (`worker`, `oracle-executor`) are blocked

In **Ask** and **Brainstorm** modes additionally:
- `write` and `edit` tool calls are filtered — only allowed for `.md`/`.mdx` files inside the project directory, anything under `/tmp/`, and anything under `~/.pi/`

In **Build** and **None** modes:
- All tools available, no write filtering, no subagent restrictions

## Build scope negotiation

When switching into **Build** mode, Pi prompts you once to choose:
- **Scope:** One task / Multiple tasks / Until I hit a problem
- **Handoff format:** Markdown in chat / HTML report / None

The choice is injected into the system prompt for that build session. If you dismiss the prompt, the agent negotiates scope naturally.

## Mode persistence

The current mode survives session reloads. On `session_start`, the extension replays the last persisted mode entry from session storage. New sessions default to **Ask**.

## How it works

The extension hooks `before_agent_start` to inject the mode prompt and handle build scope. It hooks `tool_call` for write filtering and subagent gating. Mode state is stored via `pi.appendEntry` with type `pi-mode`.

Prompt files are loaded from `~/.pi/agent/extensions/pi-modes/prompts/` at session start — the same directory where pi installs this extension's `prompts/` directory.

The extension skips all logic in subagent child processes (`PI_SUBAGENT_DEPTH > 0`) to avoid conflicting with parent session state.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
