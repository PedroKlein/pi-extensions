# pi-memory — Persistent Memory Extension

Personal memory system that learns preferences, patterns, and corrections from coding sessions.

## Architecture

```
pi-memory/
├── index.ts              # Extension entry: lifecycle, tools, commands
├── injector.ts           # Deterministic memory block builder
├── store.ts              # SQLite-backed memory store (facts, lessons, events)
├── consolidator.ts       # Session consolidation (LLM-based extraction)
├── dream/                # Background memory evolution system
│   ├── orchestrator.ts   # Dream run coordination
│   ├── session-reader.ts # Session log parser
│   ├── chain-prep.ts     # Prompt chain builder
│   ├── prompts.ts        # Dream LLM prompts
│   ├── journal.ts        # Dream journal writer
│   └── config.ts         # Dream configuration
└── category-map.json     # Project → lesson category mapping (in ~/.pi/memory/)
```

## How It Works

### Memory Injection (Deterministic)

At `session_start`, pi-memory builds a static memory block and caches it for the session:

1. **Facts** — loaded by prefix:
   - `project.{slug}.*` — current project context
   - `pref.*` — user preferences
   - `tool.*` — tool-specific preferences
   - `user.*` — user identity

2. **Lessons** — filtered by category map (`~/.pi/memory/category-map.json`):
   - Categories mapped to current project slug are included
   - `_always` categories are always included
   - No LLM filtering — deterministic, instant, never wrong

3. **System prompt injection** via `before_agent_start`:
   - Returns cached block every turn (no recomputation)
   - Display line shows: `🧠 project.{slug} | N facts | N lessons [categories]`

### Category Map

`~/.pi/memory/category-map.json` controls which lesson categories load per project:

```json
{
  "dotfiles": ["pi-memory", "pi-extension", "pi-extensions", "pi-modes", ...],
  "kms-lite": ["kms-lite-architecture", "go-dev", "go-testing", "testing", ...],
  "_always": ["general", "error-handling", "debugging", "reporting", ...]
}
```

Dream consolidation can update this file over time as it detects cross-references.

### Cross-Project Context

The injected memory only covers the current project. For other projects, the agent uses:
- `memory_search` tool — search across all facts
- `memory_lessons` tool — browse lessons by category

A footer in the memory block instructs the agent to self-serve.

### Consolidation

At session end (or `/memory-consolidate`), pi-memory:
1. Builds a consolidation prompt from the conversation
2. Calls a cheap model (via `pi --print`) to extract new facts/lessons
3. Applies extracted memories to the store

### Dream

Background evolution system that processes past sessions and refines memory.
Triggered automatically on session start (if gates pass) or manually via `/dream`.

## Configuration

In `~/.pi/agent/settings.json`:

```json
{
  "memory": {
    "consolidationEnabled": false,
    "consolidationModel": "github-copilot/claude-sonnet-4.6",
    "dream": {
      "enabled": true,
      "autoTrigger": true,
      "minSessionsBeforeRun": 3
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `consolidationEnabled` | `false` | Enable/disable session-end consolidation (Dream handles this better) |
| `consolidationModel` | `defaultModel` from settings | Model for session consolidation (when enabled) |
| `dream.enabled` | `true` | Enable/disable Dream |
| `dream.autoTrigger` | `true` | Auto-run Dream on session start |

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search semantic memory for facts by query |
| `memory_remember` | Store a fact or lesson |
| `memory_forget` | Remove a fact or lesson |
| `memory_lessons` | List learned corrections (optionally by category) |
| `memory_stats` | Show counts of facts, lessons, events |

## Commands

| Command | Description |
|---------|-------------|
| `/dream` | Manually trigger a Dream run |
| `/memory-consolidate` | Force consolidation of current session |

## Design Principles

- **No LLM in the injection path** — deterministic prefix lookups only
- **Wrong context is worse than no context** — be precise, not broad
- **The main model decides skills** — no automatic skill loading from memory
- **Agent self-serves** — cross-project context via tools, not injection
- **Simplicity > cleverness** — prefix lookup > semantic search for injection
