# pi-repos

Repo management and orchestration layer for pi. Manages a portfolio of repositories — clone, register, search across, annotate, group, and keep synced — with automatic summarization, lifecycle hooks, and AI-powered documentation.

## Tools

| Tool | Description |
|------|-------------|
| `repos_add` | Clone a URL (bare + worktree) or register a local path. Supports `tag` for pinned versions. |
| `repos_info` | Full details: entry, summary, annotations, freshness |
| `repos_list` | List all repos with path and freshness. Filter by group, tag, starred |
| `repos_remove` | Remove from index. Cloned: deletes storage. Local: index-only |
| `repos_search` | Ripgrep across repos. Scope to repo or group |
| `repos_annotate` | Append knowledge notes (architecture/pattern/bug/decision/cross-cutting) |
| `repos_reference` | Manage references on repos or groups (add/remove/list context dependencies) |
| `repos_group` | Group CRUD, connections, AI-suggested connections, docs, sync |
| `repos_sync` | Git fetch + freshness update |

## Key Concepts

### References

Unidirectional pointers from a repo or group to other repos for context. Used when:
- A repo uses an external library and you need its source locally for API understanding
- A group has context dependencies (CRD providers, shared schemas)
- You'd otherwise fetch from GitHub — reference repos are available locally

```typescript
interface Reference {
  repo: string;       // Repo ID (must exist in pi-repos index)
  tag?: string;       // Pinned version (e.g. "v3.0.1")
  reason?: string;    // Why referenced (e.g. "CRD API shapes")
}
```

References live on both individual repos (`RepoEntry.references`) and groups (`RepoGroup.references`).

### Tag/Ref Cloning

Clone repos at specific versions for context/reference use:

```json
{ "url": "https://github.com/kubernetes-sigs/kro.git", "tag": "v0.9.1" }
```

Creates a detached worktree at that tag. Entry stores `pinnedRef` for tracking.

### Groups

Groups organize related repos into systems. Features:
- **Connections**: Directional relationships between members (`depends-on`, `deploys-to`, `configures`, `shared-lib`, `imports`, `consumes`)
- **AI-suggested connections**: `repos_group suggest` reads member TL;DRs and proposes relationships
- **References**: Group-level context dependencies (shared across all members)
- **Workspace** (`docs/`): AI-generated + manually written documentation

### AI-Generated Group Docs

Triggered on: group creation (with members), connection changes, and manual regeneration.

Generated files in `groups/{name}/docs/`:
- `architecture.md` — System narrative, data flows, integration points
- `roles.md` — Each repo's role in the system
- `glossary.md` — Domain-specific terminology
- `map.md` — Mermaid dependency diagram

Manual regeneration: `repos_group { action: "docs", name: "...", docAction: "regenerate" }`

### Session Start Context Injection

When your working directory is inside a managed repo:
1. Detects repo + finds its group memberships
2. Injects all connections (inbound + outbound) with paths and TL;DRs
3. Injects all references (repo-level + group-level) with paths
4. Shows group workspace path for direct file access

## Storage Layout

```
{storageDir}/
├── index.json               # Registry of all managed repos
├── hooks.log                # Lifecycle hook execution log
├── repos/                   # All repos (cloned + local metadata)
│   └── {host}/{owner}/{name}/
│       ├── .git/            # Cloned repos: bare git clone
│       ├── {branch}/        # Cloned repos: worktree(s)
│       └── .meta/           # Always present
│           ├── tldr.md      # ≤10-line LLM-generated summary
│           ├── summary.md   # Full structured markdown summary
│           ├── rev.txt      # HEAD SHA when summary was generated
│           └── notes.md     # Knowledge annotations (append-only)
└── groups/                  # Named repo groups
    └── {name}/
        ├── group.json       # Members, connections, references, metadata
        ├── README.md        # Auto-generated overview
        ├── notes.md         # Group-level annotations
        └── docs/            # Workspace: AI-generated + user docs
            ├── architecture.md
            ├── roles.md
            ├── glossary.md
            ├── map.md
            └── *.md         # User/agent organic notes
```

## Configuration

Reads from `~/.pi/agent/settings.json` under the `"pi-repos"` key:

```json
{
  "pi-repos": {
    "storageDir": "~/Dev/pi-repos",
    "summaryModel": "hai-proxy/anthropic--claude-sonnet-4.6",
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
| `hooks` | _(none)_ | Lifecycle hook commands (see Hooks section) |

## Hooks

Hooks execute user-configured commands at lifecycle events. They fire asynchronously (non-blocking) with configurable timeouts.

### Events

| Event | When |
|-------|------|
| `post-add` | After a repo is cloned or registered |
| `post-sync` | After a repo is fetched/updated |
| `pre-remove` | Before a repo is unregistered |

### Variables

Hook args support interpolation:

| Variable | Example |
|----------|---------|
| `{path}` | `/Users/me/Dev/github.com/owner/repo/main` |
| `{id}` | `github.com/owner/repo` |
| `{branch}` | `main` |
| `{host}` | `github.com` |
| `{owner}` | `owner` |
| `{name}` | `repo` |

## Repo Entry Schema

| Field | Type | Description |
|-------|------|-------------|
| `host` | string | Git host (e.g. `github.com`) |
| `owner` | string | Repository owner |
| `name` | string | Repository name |
| `type` | `"cloned"` \| `"local"` | How the repo is managed |
| `url` | string \| null | Original clone URL |
| `path` | string | Absolute path (`.git/` for cloned, repo root for local) |
| `defaultBranch` | string | Default branch name |
| `worktrees` | WorktreeInfo[] | Detected worktrees with branch + commit |
| `tags` | string[] | User-assigned tags |
| `autoTags` | string[] | Auto-detected from manifests + LLM type classification |
| `starred` | boolean | Pinned flag |
| `pinnedRef` | string? | If cloned at a specific tag/SHA |
| `references` | Reference[]? | Unidirectional context references to other repos |
| `lastAccessed` | ISO string | Last interaction timestamp |
| `addedAt` | ISO string | When first registered |
| `lastSyncedAt` | ISO string \| null | Last git fetch timestamp |
| `commitsBehind` | number \| null | Commits behind upstream |

## Skill

Ships with a workflow-trigger skill at `skills/pi-repos/SKILL.md` that teaches agents **when** to use repos tools — especially `repos_annotate` (persist discoveries), references (use local clones instead of fetching), and group workspace docs.

## Files

```
pi-repos/
├── index.ts       # Extension entry: lifecycle hooks + tool registrations
├── types.ts       # All type definitions + config defaults
├── config.ts      # Settings.json reader, path helpers, hook parsing
├── storage.ts     # Index CRUD, repo resolution, annotations, summary I/O, reference helpers
├── clone.ts       # Clone (with tag support), register, remove, sync, list, auto-tag
├── search.ts      # Ripgrep search across repos
├── group.ts       # Group CRUD, connections, references, docs, sync
├── hooks.ts       # Lifecycle hook executor (spawn, log, toast)
├── summarize.ts   # TL;DR + full summary + group doc generation via pi --print
├── suggest.ts     # AI connection suggestion logic
├── skills/
│   └── pi-repos/
│       └── SKILL.md  # Workflow-trigger skill
└── README.md      # This file
```
