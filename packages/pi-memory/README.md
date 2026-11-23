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
| `memory_stats` | Show fact, pin, and event counts plus the agent directory, database path, and storage mode |
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

For CLI usage, the default database follows the current agent directory from Pi's process-level `getAgentDir()` (CLI/environment). SDK hosts must inject their session directory explicitly as described below:

- Standard `~/.pi/agent`: `~/.pi/memory/memory.db` (unchanged for compatibility).
- Any other agent directory: `<agent-dir>/memory/memory.db`.

The same agent uses the same default across working directories. No memories are copied or inherited from another agent. This is path-based separation, not an OS sandbox.

Every successful `session_start`, including an empty store, reports the normalized absolute `agentDir`, selected absolute `dbPath`, and `storageMode`:

- `legacy-global`: standard-agent compatibility database.
- `agent-local`: a custom agent's default database.
- `project-local`: an explicit trusted `localPath`, even when it equals a default path.

TUI/RPC receive an info notification via Pi's UI. Print/JSON receive one JSON-encoded line on stderr, never bare text on stdout. Paths containing newlines or control characters are escaped. Diagnostics are not injected into the model prompt or written to a separate persistent log. `memory_stats` exposes the same `agentDir` and `storageMode` alongside its existing fields. Failed initialization emits no success diagnostic and clears the selected storage state.

To use a project-local store, add this to `<project>/.pi/settings.json`:

```json
{
  "pi-memory": {
    "localPath": "./.pi/memory"
  }
}
```

`localPath` is a directory; `memory.db` is appended. Absolute paths are supported, and relative paths resolve from the project working directory. This project override is read only when `ctx.isProjectTrusted()` is true and takes precedence over the agent default. Global merged settings are not used for this override.

Only a full normalized/resolved path match selects the standard-agent compatibility path; names, substrings, and prefixes do not. Existing symlink aliases, including valid parent aliases above missing tail components, are equivalent before and after directory creation. A genuinely missing agent directory is allowed, but dangling symlinks and path/permission errors are initialization failures.

Missing configuration uses the agent default. Malformed, invalid, or unreadable configuration, directory-creation failures, and SQLite open/PRAGMA/migration failures disable memory and report only the affected path and error type, without falling back to another database or retaining old cached memories. TUI/RPC receive an error notification; print/JSON modes receive a thrown initialization error through Pi's extension-error reporting. Unavailable tools retain the same safe diagnostic until initialization succeeds.

All persistent state is in the selected SQLite database: facts, pins, and event history. SQLite WAL/SHM sidecars (`memory.db-wal`, `memory.db-shm`) stay alongside it. SQLite temporary query data stays in memory only (`PRAGMA temp_store = MEMORY`). The extension creates no separate cache, log, lock, backup, or IPC files; its prompt cache is in memory only. Project settings are read, never written.

Existing databases remain compatible. Legacy lesson and Dream tables are left untouched but are no longer read or written by the extension. Missing `pinned` columns are migrated without replacing existing facts, timestamps, or event history.

Independent processes can open the same selected store: schema inspection/migration is serialized in an immediate transaction, and `busy_timeout` is configured before enabling WAL. WAL lock-upgrade contention is retried only for confirmed SQLite BUSY/LOCKED codes, with a bounded same-connection wait. Each WAL attempt uses only the remaining 5-second phase budget for SQLite internal waits; the regular 5000ms busy timeout is restored afterwards. This budget does not include the separate migration transaction. Other errors still fail closed; there is no fallback store or external lock service.

Multi-process concurrency guarantees database consistency, not live synchronization of prompt caches: another already-started session's pinned-memory cache does not automatically refresh after external changes. Reload that session to refresh its injected pins.

### SDK sessions

The current SDK does not expose the session's `agentDir` in extension context. Passing only `createAgentSession({ agentDir })` does **not** pass it to this extension: `getAgentDir()` still returns the process default. Do not switch process environment variables between sessions.

Use the named `createMemoryExtension({ agentDir })` factory and pass the **same directory** to the factory, resource loader, and session. Each factory captures its own directory, including across repeated `session_start` events. The default export remains the CLI/env entry.

Import from the source file in your checkout (adjust the relative path), rather than the package-root exports/types, whose existing dist packaging is outside this change:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "./packages/pi-memory/src/index.ts";

const agentDir = "/absolute/path/to/sdk-agent";
const cwd = "/absolute/path/to/project";
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  // Load memory only through this inline factory, not also through its default entry.
  noExtensions: true,
  extensionFactories: [createMemoryExtension({ agentDir })],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader });
await session.bindExtensions({ mode: "print" });
// Use the session; shut down extensions and dispose it when finished.
```

## Development

```bash
cd packages/pi-memory
pnpm test
pnpm typecheck
pnpm build
```

With dependencies already installed, the corresponding tools in `node_modules/.bin` can also be called directly.

The concurrency suite uses native TypeScript support in Node 24/26, four independent Node workers per store, IPC barriers (not timing sleeps), and temporary directories only. It covers cold starts, existing stores, concurrent legacy migration, different working directories sharing one agent, and two isolated agent groups (eight workers). Every worker is awaited or killed and awaited on failure. Writes, shared-key updates, event counts, cleanup, and SQLite integrity are checked against the real database.

## License

MIT
