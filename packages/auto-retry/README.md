# Auto-Retry Extension

Detects malformed tool call JSON errors and automatically retries.

## Problem

Sometimes the LLM generates invalid JSON in tool call parameters — especially with large `edit` calls containing code with template literals, backticks, unicode escapes, or nested quotes. When this happens, pi shows:

```
Unexpected non-whitespace character after JSON at position 4210 (line 1 column 4211)
```

The agent stops dead, requiring manual intervention.

## Solution

This extension hooks into `agent_end`, checks if the last assistant message failed with a JSON parse error, and automatically sends a follow-up user message asking the LLM to retry with smaller, simpler edits.

## Behavior

- Detects JSON parse errors in `AssistantMessage.errorMessage` (covers `Unexpected token`, `unterminated string`, `bad control character`, etc.)
- Sends a retry message instructing the model to break the edit into smaller pieces
- Max **2 consecutive retries** per agent run — resets on any successful turn
- Shows a flash notification on retry so you know what happened
- Gives up with an error notification after max retries to avoid loops

## Configuration

Edit `MAX_RETRIES` in `index.ts` to change the retry limit (default: 2).
