# Caffeinate Extension

Prevents the system from sleeping while the Pi agent is actively working.

## How It Works

Spawns a platform-native sleep inhibitor when the agent starts, kills it when the agent finishes.

| Platform | Command | Behavior |
|----------|---------|----------|
| **macOS** | `caffeinate -i -w <pid>` | Prevents idle sleep; auto-exits if Pi crashes (`-w` watches the PID) |
| **Linux** | `systemd-inhibit --what=idle sleep infinity` | Inhibits idle sleep via systemd |

## Lifecycle

| Event | Action |
|-------|--------|
| `agent_start` | Spawn inhibitor process |
| `agent_end` | Kill inhibitor process |
| `session_shutdown` | Kill inhibitor process (cleanup) |

## Status Indicator

While active, shows a **☕** icon in the Pi status bar.

## Concurrency

Multiple Pi sessions are safe — the OS deduplicates multiple inhibit assertions naturally, so concurrent sessions add zero overhead.
