# pi-caffeinate

Prevents the system from sleeping while Pi is working. Spawns a platform-native
sleep inhibitor when the agent starts, kills it when the agent finishes.

I built this because long agent runs would let the laptop sleep mid-task, killing
the process. This extension solves that without requiring any manual intervention.

## Install

```bash
pi install npm:@pedro_klein/pi-caffeinate
```

## What it provides

No tools or commands — runs silently in the background.

**Events handled:**

| Event | Action |
|-------|--------|
| `agent_start` | Spawn sleep inhibitor |
| `agent_end` | Kill sleep inhibitor |
| `session_shutdown` | Kill sleep inhibitor (crash/quit cleanup) |

While active, shows a **☕** icon in the Pi status bar (requires [pi-status](https://github.com/PedroKlein/pi-extensions/tree/main/packages/pi-status)).

## How it works

On `agent_start`, spawns a platform-native inhibitor:

| Platform | Command | Notes |
|----------|---------|-------|
| macOS | `caffeinate -i -w <pid>` | Prevents idle sleep; `-w` watches Pi's PID and auto-exits if Pi crashes |
| Linux | `systemd-inhibit --what=idle sleep infinity` | Inhibits idle sleep via systemd |
| Other | (no-op) | Silently does nothing |

On `agent_end` or `session_shutdown`, kills the inhibitor process.

Multiple concurrent Pi sessions are safe — the OS deduplicates multiple inhibit
assertions naturally, so running several sessions adds zero overhead.

## Configuration

No configuration required — works out of the box.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
