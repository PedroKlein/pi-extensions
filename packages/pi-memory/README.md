# pi-memory

Persistent memory for [Pi](https://pi.dev) — learns preferences, corrections, and patterns across sessions and injects relevant context into every conversation.

I built this because I was tired of re-explaining my project conventions and personal preferences every session. The memory persists across reboots, projects, and model switches.

## Install

```bash
pi install npm:@pedroklein/pi-memory
```

## What it provides

**Tools:**

| Tool | Description |
|------|-------------|
| `memory_search` | Full-text search across all stored facts (FTS5 when available, substring fallback) |
| `memory_remember` | Store a fact (`type: "fact"`) or correction (`type: "lesson"`) |
| `memory_forget` | Remove a fact by key or a lesson by ID |
| `memory_lessons` | List learned corrections, optionally filtered by category |
| `memory_stats` | Count of facts, lessons, and logged events; shows DB path |

**Commands:**

| Command | Description |
|---------|-------------|
| `/dream` | Run Dream manually — mines unprocessed sessions and refines memory |
| `/memory-consolidate` | Trigger consolidation of the current session's conversation |

**Events handled:** `session_start`, `before_agent_start`, `agent_end`, `session_before_switch`, `session_shutdown`

## Memory model

There are two types of stored memory:

**Facts** — key-value pairs with a dotted namespace:
- `pref.*` — personal coding preferences (`pref.commit_style`, `pref.editor`)
- `project.<slug>.*` — per-project context (`project.rosie.di`, `project.kms-lite.auth`)
- `tool.*` — tool-specific patterns (`tool.sed.usage`, `tool.grep.preference`)
- `user.*` — identity facts (`user.name`, `user.timezone`)

**Lessons** — free-text rules with categories and a negative flag:
- Positive (`negative: false`): validated approaches ("always draft before publishing")
- Negative (`negative: true`): corrections to avoid ("don't use echo >> for file insertion")

Both types are stored in a SQLite database at `~/.pi/memory/memory.db`.

## System prompt injection

At `session_start`, pi-memory builds a deterministic context block from the store:

1. **Facts** — loaded by prefix for the current project, preferences, and tools
2. **Lessons** — filtered by `~/.pi/memory/category-map.json` (project slug → categories)

The block is cached once per session and injected via `before_agent_start` every turn. No LLM is involved in injection — it's a fast prefix lookup. The context block shows as `🧠 project.<slug> | N facts | N lessons [categories]` in the conversation.

Facts older than 30 days get a `(Nd ago)` staleness tag; older than 90 days get a warning.

### Category map

Control which lesson categories load per project:

```json
// ~/.pi/memory/category-map.json
{
  "_always": ["general", "debugging", "workflow"],
  "my-project": ["go-dev", "testing", "my-project-architecture"],
  "pi-extensions": ["pi-memory", "pi-extension", "typescript"]
}
```

`_always` categories load on every project. Per-project entries add on top.

## Dream

Dream is a background system that mines finished sessions and evolves memory over time. It runs as a 3-stage LLM chain:

1. **Miner** — extracts raw facts and lessons from session batches
2. **Refiner** — merges, deduplicates, and sharpens the extracted candidates against existing memory and skills
3. **Advisor** — produces workflow insights (skill gaps, tool usage patterns, efficiency observations)

Dream runs automatically on `session_start` when gates pass (default: every 24 hours with ≥5 unprocessed sessions). Results are written to `~/.pi/memory/dream-journal/`. Run manually with `/dream`.

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
      "minHoursSinceDream": 24,
      "minSessionsSinceDream": 5,
      "minerModel": "github-copilot/gpt-5.4-mini",
      "refinerModel": "github-copilot/claude-sonnet-4.6",
      "advisorModel": "github-copilot/claude-sonnet-4.6",
      "journalDir": "~/.pi/memory/dream-journal",
      "sessionsDir": "~/.pi/agent/sessions",
      "skillsDir": "~/.agents/skills"
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `consolidationEnabled` | `false` | Session-end consolidation (Dream does this better) |
| `consolidationModel` | `defaultModel` from settings | Model for session consolidation |
| `dream.enabled` | `true` | Enable/disable Dream |
| `dream.autoTrigger` | `true` | Auto-run Dream on session start |
| `dream.minHoursSinceDream` | `24` | Minimum hours between Dream runs |
| `dream.minSessionsSinceDream` | `5` | Minimum unprocessed sessions to trigger Dream |

**Local project override** — put `"pi-memory": { "localPath": "./.pi/memory" }` in `.pi/settings.json` to use a project-local database instead of the global one.

## Storage

| Path | Purpose |
|------|---------|
| `~/.pi/memory/memory.db` | SQLite database (facts, lessons, events, Dream state) |
| `~/.pi/memory/category-map.json` | Project → lesson category mapping |
| `~/.pi/memory/dream-journal/` | Timestamped markdown reports from Dream runs |
| `~/.pi/memory/dream-sessions/` | Session files for consolidation subprocess |

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
