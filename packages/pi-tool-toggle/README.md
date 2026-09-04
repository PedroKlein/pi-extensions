# pi-tool-toggle

Session-scoped tool toggles for Pi.

## Install

```bash
pi install npm:@pedro_klein/pi-tool-toggle
```

## Configuration

Tools listed in the active Pi agent directory's `settings.json` start disabled when a session has no saved tool state:

```json
{
  "pi-tool-toggle": {
    "defaultDisabled": ["ssh_session"]
  }
}
```

Run `/tools` to enable or disable registered tools. Changes apply immediately and are stored in the current session branch, so they survive reload and resume without affecting other sessions.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT
