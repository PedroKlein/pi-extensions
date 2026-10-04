# pi-memory

Curated persistent memory for [Pi](https://pi.dev).

`pi-memory` stores durable facts that are useful across sessions. It does not mine conversations or infer new memories automatically. The user or agent must explicitly save each fact.

## Install

```bash
pi install npm:@pedro_klein/pi-memory
```

## Tools

| Tool | Description |
|---|---|
| `memory_search` | Search facts or list them with pagination |
| `memory_remember` | Store one durable fact or preference |
| `memory_forget` | Remove one fact by key |
| `memory_stats` | Show fact, pin, and event counts plus the database path |
| `memory_pin` | Pin, unpin, or list facts used for automatic prompt injection |

## Store a fact

Use dotted keys with a stable scope:

- `pref.*` for preferences that apply across projects
- `project.<slug>.*` for facts specific to one repository
- `tool.*` for stable tool behavior
- `user.*` for durable identity facts

Keep values concise. Do not store session progress, commit hashes, file contents, facts that can be read from the repository, or credentials. A `project.<slug>.*` write must match the current repository; use the repository's own session to record it.

Credential-shaped values are rejected before they reach SQLite.

## Search and list facts

`memory_search` accepts an optional query, scope, offset, and limit.

| Scope | Result |
|---|---|
| `current` | Global facts and facts for the current repository; default |
| `global` | Facts outside `project.*` |
| `all` | Every repository; intended for explicit audits |

Omit `query` to list facts in stable key order. Use `offset` and `nextOffset` for pagination.

Repository scope is derived from the Git worktree root. A managed path such as `~/Dev/<host>/<owner>/<repo>/main` resolves to `<repo>`, not `main`.

## Pinned facts

Pinned facts are the only memories injected automatically. Global pins are available everywhere; `project.<slug>.*` pins are injected only in the matching repository.

The injected block has a fixed 500-token budget and stable key order. Facts that do not fit remain searchable.

Pin only behavior that must be present on every turn. Ordinary facts should stay searchable rather than occupying the system prompt.

## Storage

The default database is:

```text
~/.pi/memory/memory.db
```

To use a project-local store, add this to `<project>/.pi/settings.json`:

```json
{
  "pi-memory": {
    "localPath": "./.pi/memory"
  }
}
```

Relative paths resolve from the project working directory.

Existing databases remain compatible. Legacy lesson and Dream tables are left untouched but are no longer read or written by the extension.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT
