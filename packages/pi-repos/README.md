# pi-repos

Repo management and orchestration layer for Pi. I built this to manage a portfolio of
repositories across projects — clone them into a canonical layout, search across them,
annotate discoveries, connect related repos into groups, and surface context automatically
when I start working in a directory.

## Install

```bash
pi install npm:@pedroklein/pi-repos
```

## What it provides

**Tools:**

| Tool | Description |
|------|-------------|
| `repos_add` | Clone a URL (bare + worktree) or register a local path. Supports `tag` for pinned versions. |
| `repos_info` | Full details: path, worktrees, TL;DR, annotations, freshness |
| `repos_list` | List all repos with path and freshness. Filter by group, tag, starred |
| `repos_remove` | Remove from index. Cloned: deletes storage. Local: index-only |
| `repos_search` | Ripgrep across repos. Scope to a repo or group |
| `repos_annotate` | Append knowledge notes (architecture/pattern/bug/decision/cross-cutting) |
| `repos_reference` | Manage context references on repos or groups (add/remove/list) |
| `repos_group` | Group CRUD, directional connections, AI-suggested connections, docs, sync |
| `repos_sync` | Git fetch + freshness update |

**Skills:** `skills/pi-repos/SKILL.md` — teaches agents when and how to use repos tools,
especially `repos_annotate` (persist architectural discoveries) and `repos_reference`
(use local clones instead of fetching from GitHub).

## Core Concepts

### Repo Index

All repos live in a single `index.json`. Each entry tracks: type (cloned vs local),
paths, worktrees, tags, star status, freshness (last sync, commits behind), and
AI-generated TL;DRs.

Cloned repos are stored as bare git clones with worktrees:
```
{storageDir}/repos/{host}/{owner}/{name}/
├── .git/           # bare clone
├── main/           # default branch worktree
└── .meta/
    ├── tldr.md     # ≤10-line AI summary
    ├── summary.md  # full structured summary
    ├── rev.txt     # HEAD SHA at summary time
    └── notes.md    # annotations (append-only)
```

### Annotations

Append-only knowledge notes on any repo or group. Five categories:

| Category | Use for |
|----------|---------|
| `architecture` | Structural decisions, module boundaries, data flow |
| `pattern` | Reusable idioms, conventions found in the codebase |
| `bug` | Known bugs, gotchas, footguns, workarounds |
| `decision` | Design decisions with rationale (ADR-lite) |
| `cross-cutting` | Observations spanning multiple repos or modules |

### References

Unidirectional pointers from a repo or group to other repos for context. Useful when:
- A repo uses an external library and you want its source locally for API understanding
- A group has context dependencies (CRD providers, shared schemas)
- You'd otherwise fetch from GitHub — referenced repos are available locally

```typescript
interface Reference {
  repo: string;       // Repo ID — must exist in pi-repos index
  tag?: string;       // Pinned version (e.g. "v3.0.1")
  reason?: string;    // Why referenced (e.g. "CRD API shapes")
}
```

### Groups

Groups organize related repos into systems:
- **Connections** — Directional relationships between members (`depends-on`, `deploys-to`, `configures`, `shared-lib`, `imports`, `consumes`)
- **AI-suggested connections** — `repos_group suggest` reads member TL;DRs and proposes relationships
- **References** — Group-level context dependencies shared across all members
- **Workspace** (`docs/`) — AI-generated + manually written documentation

AI-generated docs in `groups/{name}/docs/`:
- `architecture.md` — System narrative, data flows, integration points
- `roles.md` — Each repo's role in the system
- `glossary.md` — Domain-specific terminology
- `map.md` — Mermaid dependency diagram

### Session Context Injection

When your working directory is inside a managed repo, pi-repos automatically:
1. Detects the repo and finds its group memberships
2. Injects all connections (inbound + outbound) with paths and TL;DRs into the LLM context
3. Injects all references (repo-level + group-level) with local paths
4. Shows the group workspace path for direct doc access

## Storage Layout

```
{storageDir}/
├── index.json               # Registry of all managed repos
├── hooks.log                # Lifecycle hook execution log
├── repos/                   # All repos (cloned + local metadata)
│   └── {host}/{owner}/{name}/
│       ├── .git/            # Bare git clone (cloned repos)
│       ├── {branch}/        # Worktree(s)
│       └── .meta/
│           ├── tldr.md
│           ├── summary.md
│           ├── rev.txt
│           └── notes.md
└── groups/
    └── {name}/
        ├── group.json       # Members, connections, references, metadata
        ├── notes.md         # Group-level annotations
        └── docs/            # Workspace docs
```

## Configuration

Reads from `~/.pi/agent/settings.json` under the `"pi-repos"` key. No configuration
required to get started — defaults work out of the box.

```json
{
  "pi-repos": {
    "storageDir": "~/Dev/pi-repos",
    "summaryModel": "hai-proxy/anthropic--claude-sonnet-4-5",
    "hooks": {
      "post-add": [
        { "command": "gitnexus", "args": ["analyze", "--skip-agents-md", "--skip-skills", "{path}"], "timeout": 180000 }
      ],
      "post-sync": [
        { "command": "gitnexus", "args": ["analyze", "--skip-agents-md", "--skip-skills", "{path}"], "timeout": 180000 }
      ]
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `storageDir` | `~/.local/share/pi-repos` | Root directory for all storage |
| `summaryModel` | _(pi's default model)_ | Override model for TL;DR and group doc generation |
| `hooks` | _(none)_ | Lifecycle hook commands (post-add, post-sync, pre-remove) |

### Lifecycle Hooks

Hooks execute user-configured commands at lifecycle events, asynchronously (non-blocking).
Hook args support variable interpolation: `{path}`, `{id}`, `{branch}`, `{host}`, `{owner}`, `{name}`.

| Event | When |
|-------|------|
| `post-add` | After a repo is cloned or registered |
| `post-sync` | After a repo is fetched/updated |
| `pre-remove` | Before a repo is unregistered |

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
