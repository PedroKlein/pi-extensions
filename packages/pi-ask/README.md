# pi-ask

Interactive TUI questionnaire for [Pi](https://github.com/earendil-works/pi-coding-agent). Instead of the agent listing options as plain text and asking you to reply with a number, this gives you a proper interactive form — tabs for multi-question flows, a detail panel, LLM explanations per option, and annotations.

## Install

```bash
pi install npm:@pedroklein/pi-ask
```

## What it provides

- **Tool:** `ask_user` — the agent calls this to present structured questions
- **Command:** `/answer` — parse the last assistant message into the same TUI form
- **Prompt enforcement:** injects a `before_agent_start` hook instructing the agent to always use `ask_user` instead of plain-text numbered lists

## Tool: ask_user

The agent calls `ask_user` with an array of questions. Pi renders the TUI form and returns answers as structured text.

**Parameters:**

```ts
{
  questions: Array<{
    id: string            // unique identifier
    prompt: string        // full question text
    type: "single"        // pick one (radio)
         | "multi"        // pick many (checkbox)
         | "text"         // free-form input
    label?: string        // short tab label (defaults to Q1, Q2…)
    context?: string      // help text shown below the prompt
    options?: Array<{
      value: string
      label: string
      description?: string   // shown in detail panel when highlighted
      recommended?: boolean  // shows ★ badge
      action?: {
        type: "mode-switch"
        mode: string         // e.g. "build", "plan", "ask"
      }
    }>
  }>
}
```

Options with an `action` field automatically fire that action when the user selects and submits. The `mode-switch` action emits a `pi-ask:mode-switch` event (consumed by [pi-modes](../pi-modes)).

## UI layout

```
╭── ask_user ──────────────────────────────────────────────────╮
│ ■ Approach  □ Config  □ Testing  ✓ Submit                    │
│                                                              │
│  Which approach should we use?                               │
│                                                              │
│  (●) Option A ★           │ Option A                         │
│  ( ) Option B              │                                  │
│  ( ) Option C              │ Detailed description shown here  │
│  ⊕ Other: type your own...│ when this option is highlighted. │
│                            │                                  │
│                            │ ★ Recommended                    │
│     📝 "my annotation"    │                                  │
│                            │ 💬 Auto-explain                  │
│                            │ LLM explanation appears here     │
│                            │ after pressing ?                 │
│                                                              │
│  ↑↓ navigate • Space select • a annotate • ? explain • ...  │
╰──────────────────────────────────────────────────────────────╯
```

## Features

- **Detail panel** — descriptions shown on the right when an option is highlighted
- **Recommended badge** (★) — the agent marks preferred options; reasoning goes in the description
- **Annotations** (`a`) — add a one-liner note to any selected option; auto-selects if not already selected
- **Global note** (`n`) — add a free-form note to the whole questionnaire before submitting
- **LLM explain** (`?`) — ask the model to explain an option's trade-offs; answers are cached per option. Empty input = auto-explain, or type a specific question
- **Custom input** ("Other") — type a custom answer when none of the options fit
- **Multi-question tabs** — Tab/←→ to navigate; Submit tab shows a review before confirming
- **Scroll** — J/K scrolls the detail panel; left panel auto-scrolls with the cursor

## Keybindings

| Key | Action |
|-----|--------|
| `↑ / ↓` | Navigate options |
| `Space` | Toggle selection (auto-advances for single) |
| `Enter` | Confirm and advance |
| `a` | Annotate highlighted option |
| `n` | Add/edit global note |
| `?` | Ask about / explain option |
| `J / K` | Scroll detail panel |
| `Tab / ← →` | Switch between questions |
| `Esc` | Cancel |

## Command: /answer

Parses the last assistant message into a questionnaire using a quick LLM call, then opens the same TUI form. Useful when the agent produces plain-text options — `/answer` extracts and structures them.

Requires an active model and interactive mode.

## Output format

The tool returns plain text to the agent:

```
User answers:
- Approach: Option A
    → "my annotation about why"
- Config: Custom value (custom)
- Testing: Option X
- Additional notes: some context I wanted to add
```

Cancelled questionnaires return a message instructing the agent to use recommended options and proceed.

## Configuration

No configuration required — works out of the box.

The prompt enforcement (`ask_user` always, never plain-text lists) is injected automatically on every agent start.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
