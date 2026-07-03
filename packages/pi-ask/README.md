# Pi Ask Extension

Interactive TUI questionnaire tool for structured decision-making between the agent and the user.

## Components

### `ask_user` Tool

The agent calls this tool to present structured questions instead of listing options as plain text. The system prompt enforces this behavior.

**Question types:**
- **single** — Radio select (pick one)
- **multi** — Checkbox select (pick many)
- **text** — Free-form text input

### `/answer` Command

Parses the last assistant message into a structured questionnaire via a quick LLM call. Useful when the agent outputs questions as plain text (e.g., in a model that doesn't support tools well) — `/answer` extracts them and opens the same interactive TUI.

### Prompt Enforcement

Injects a `before_agent_start` hook that appends to the system prompt: agents must always use `ask_user` for decisions, never plain-text numbered lists.

## UI Layout

Split-panel interface with tabs for multi-question flows:

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
│                            │ LLM explanation of this option   │
│                            │ appears here after pressing ?    │
│                                                              │
│  ↑↓ navigate • Space select • a annotate • ? explain • ...  │
╰──────────────────────────────────────────────────────────────╯
```

## Features

- **Option descriptions** — Detail panel on the right shows description when an option is highlighted
- **Recommended badge** (★) — Agent marks preferred options with reasoning in the description
- **Annotations** (`a` key) — Add a one-liner note to any selected option (auto-selects if not already selected)
- **Global note** (`n` key) — Add an optional free-form note to the entire questionnaire before submitting. Accessible from any question or the Submit tab.
- **LLM explain** (`?` key) — Ask the model to explain an option's trade-offs; answers are cached per option. Press `?` with empty input for auto-explain, or type a specific question
- **Custom input** ("Other") — Type a custom answer if none of the options fit
- **Multi-question tabs** — Tab/←→ to navigate between questions; submit tab shows review summary
- **Scroll** (J/K) — Scroll the detail panel when content overflows
- **Left panel scroll** — Options list auto-scrolls with cursor when there are many options

## Keybindings

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate options |
| `Space` | Toggle selection (auto-advances for single-select) |
| `Enter` | Confirm and advance (single: select + next, multi: next if selections exist) |
| `a` | Annotate selected option |
| `n` | Add/edit global note (available from any question or Submit tab) |
| `?` | Ask about / explain option (LLM call) |
| `J/K` | Scroll detail panel |
| `Tab/←→` | Switch between questions (multi-question) |
| `Esc` | Cancel questionnaire |

## Output to Agent

The tool returns structured text to the agent:

```
User answers:
- Approach: Option A
    → "my annotation about why"
- Config: Custom value (custom)
- Testing: Option X
- Additional notes: some context I wanted to add
```
