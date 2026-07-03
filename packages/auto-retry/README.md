# pi-auto-retry

Automatically retries when the LLM generates malformed tool call JSON. Saves you from having to manually tell the agent to try again.

## Install

```bash
pi install npm:@pedroklein/pi-auto-retry
```

## What it provides

- **Events:** Hooks into `agent_end` to detect JSON parse errors and auto-retry
- **Notifications:** Shows a flash when retrying so you know what happened

No tools or commands registered — this extension works silently in the background.

## How it works

Sometimes the LLM generates invalid JSON in tool call parameters — especially with large `edit` calls containing template literals, backticks, unicode escapes, or nested quotes. When this happens, pi shows an error like:

```
Unexpected non-whitespace character after JSON at position 4210
```

This extension detects JSON parse errors in the assistant message's `errorMessage` field and sends a follow-up message asking the LLM to retry with smaller, simpler edits.

**Behavior:**
- Detects: `Unexpected token`, `unterminated string`, `bad control character`, etc.
- Sends a retry message instructing the model to break the edit into smaller pieces
- Max **2 consecutive retries** — resets on any successful turn
- Gives up with an error notification after max retries to avoid loops

## Configuration

No configuration required — works out of the box.

To change the retry limit, edit `MAX_RETRIES` in the source (default: 2).

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
