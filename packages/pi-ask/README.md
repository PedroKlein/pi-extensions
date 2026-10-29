# pi-ask

Interactive TUI questionnaire for [Pi](https://github.com/earendil-works/pi-coding-agent). Instead of the agent listing options as plain text and asking you to reply with a number, this gives you a proper interactive form — tabs for multi-question flows, a detail panel, LLM explanations per option, and annotations.

## Install

```bash
pi install npm:@pedro_klein/pi-ask
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
    }>
  }>
}
```

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
- **LLM explain option** (`?`) — ask the model to explain an option's trade-offs; answers are cached per option. Empty input = auto-explain, or type a specific question
- **Explain this question** (`e`) — opens a separate view explaining what you are deciding, why it matters, and unfamiliar terms. Uses the active conversation as background without selecting an answer. Inside this view, `?` asks a private follow-up, `r` retries a failed request or requests a simpler explanation, `J/K` scrolls, and `Esc` returns to your unchanged answers.
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
| `?` | Ask about / explain highlighted option |
| `e` | Explain the current question in a separate view |
| `J / K` | Scroll detail panel or question explanation |
| `Tab / ← →` | Switch between questions |
| `Esc` | Cancel |

## Question explanation context

Question explanations use an independent call to the currently selected model. The call receives a text snapshot of the active conversation when the form opens, including compaction summaries and model-visible tool output, plus the current question and option descriptions. Images, system instructions, and private reasoning are not forwarded. The explainer has no tools and cannot inspect files or recover details omitted by compaction.

Clarification exchanges are kept in memory per question for the lifetime of the form. They are not added to the main conversation, included in tool results, or sent back by `/answer`. Returning to a question reuses its explanation and private follow-up history. Closing the form discards that history. Normal model-provider processing and usage accounting still apply; “private” here means separate from the main conversation, not a local-only model call.

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
