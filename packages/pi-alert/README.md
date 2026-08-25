# pi-alert

System notifications for [Pi](https://github.com/earendil-works/pi-coding-agent). It alerts when an agent run finishes and when a configured tool starts.

## Install

```bash
pi install npm:@pedro_klein/pi-alert
```

## Tool alerts

Add tool names and notification messages under `pi-alert.toolAlerts` in `~/.pi/agent/settings.json`:

```json
{
  "pi-alert": {
    "toolAlerts": {
      "ask_user": "Waiting for your answer",
      "approval_gate": "Approval required"
    }
  }
}
```

Trusted project settings in `.pi/settings.json` can add or override entries. Invalid values are ignored. Reload Pi after changing settings.

Tool alerts fire on `tool_execution_start`, before the tool executes. Agent completion notifications continue to fire on `agent_end` and summarize elapsed time and tool activity.

## Notification delivery

Delivery is terminal-first, with an operating-system fallback:

- **Ghostty on macOS**: native Notification Center delivery through Ghostty
- **Ghostty on other platforms**, **WezTerm**, and **rxvt-unicode**: OSC 777
- **iTerm2**: OSC 9
- **Kitty**: OSC 99
- **tmux**: passthrough to supported outer terminals
- **macOS**: `osascript`
- **Linux**: `notify-send`
- **Windows**: PowerShell notification
- **Final fallback**: terminal bell

## Development

```bash
pnpm --filter @pedro_klein/pi-alert test
pnpm --filter @pedro_klein/pi-alert typecheck
pnpm --filter @pedro_klein/pi-alert build
```

## Attribution

Derived from [maxpetretta/pi-alert](https://github.com/maxpetretta/pi-alert), copyright Max Petretta, under the MIT License. See [LICENSE](LICENSE).
