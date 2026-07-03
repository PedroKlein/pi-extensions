# pi-todo

Terminal-first TODO board for Pi — tasks, PR reviews, and project tracking, all
without leaving the agent.

I built this because I wanted task management that lives where I actually work.
Tasks are repo-scoped automatically (detected from `git remote origin`), PR reviews
are first-class items with AI summary and clone-review actions, and the board shows
up as a startup snapshot so I always know what's open.

## Install

```bash
pi install npm:@pedroklein/pi-todo
```

## What it provides

**Tools**

- **`todo`** — Read and write tasks. The agent calls this to manage your board.
  - `list` — list tasks for the current repo (or all scopes with `scope: "all"`)
  - `add` — create a task with title, type, priority, description, due date, url, note
  - `update` — update any field on a task by ID
  - `complete` — mark a task done by ID
  - `delete` — remove a task by ID

**Commands**

- **`/todo`** — Open the interactive board (TUI overlay)
- **`/todo <description>`** — AI-capture a task from natural language (e.g. `/todo fix the auth bug before Friday`)
- **`/todo <PR-URL>`** — Create a PR review task from a GitHub/GitHub Enterprise URL
- **`/todo-repo`** — Show the current repo scope used for task association

**Shortcuts**

- **`Ctrl+Shift+B`** — Open the board from anywhere

**Startup snapshot**

Every session start prints a multi-column board to the chat (grouped by task type,
color-coded by urgency). The snapshot is filtered out of LLM context — the agent
only sees tasks you explicitly surface via the `todo` tool.

## Task model

**Types**

| Type | Scope | Description |
|------|-------|-------------|
| `feature` | repo | New capability or improvement |
| `bug` | repo | Something broken |
| `chore` | repo | Maintenance, refactoring |
| `research` | repo | Investigation or exploration |
| `review` | reviews (global) | PR review — always cross-repo |
| `personal` | personal (global) | Non-work task |

**Priorities:** `low` · `medium` · `high`

**Statuses:** `open` · `blocked` · `done`

**Urgency** (drives sort order and color):
- overdue — past due date → red
- due-soon — within 48h → yellow
- blocked → muted
- normal → default
- done → dim

## Scoping

Tasks are associated with the current git repo (detected from `git remote origin`).
The repo slug format is `owner__repo` (e.g. `pedroklein__dotfiles`).

Special scopes that are always visible regardless of current repo:
- `personal` — personal/non-work tasks
- `work` — cross-project work tasks
- `reviews` — PR review tasks

When in a specific repo, the board shows that repo's tasks plus all three global scopes.

## PR review workflow

Paste a PR URL into `/todo` to create a review task:

```
/todo https://github.com/owner/repo/pull/123
```

Pi fetches PR metadata (title, author, branch, state) from the GitHub API, creates
a review task, and adds it to the `reviews` scope. From the board, review tasks
have three actions:

| Key | Action | Description |
|-----|--------|-------------|
| `s` | AI Summary | Fetch the PR diff and generate a structured review with Q&A |
| `o` | Open in browser | Open the PR URL |
| `c` | Clone & Review | Clone the repo to `/tmp`, open a new Pi session for deep review |

Requires a GitHub token discoverable via `gh auth token`, `GITHUB_TOKEN`, or
`GH_TOKEN`. Without a token, falls back to unauthenticated API calls (rate-limited).

## AI task capture

`/todo <text>` uses a three-tier strategy to parse natural language into structured tasks:

1. **BAML** (if `@pedroklein/pi-baml` is installed) — typed structured extraction
2. **LLM** — call Pi's current model with a structured prompt
3. **Heuristics** — keyword matching fallback (always available)

The parsed task shows in a preview modal where you can edit fields before saving.
Relative dates ("next Friday", "in 2 weeks") are resolved to `YYYY-MM-DD`.

## Board TUI

Open with `/todo` or `Ctrl+Shift+B`.

**List view**

| Key | Action |
|-----|--------|
| `h` / `l` | Switch scope tab |
| `j` / `k` | Move task selection |
| `Enter` | Open task details |
| `d` | Toggle done |
| `x` | Delete task |
| `n` | Add/edit note |
| `f` | Cycle status filter (active → open → blocked → done → all) |
| `i` | Inject task into conversation |
| `o` | Open URL in browser |
| `s` | AI summary (review tasks) |
| `c` | Clone & review (review tasks) |
| `Esc` / `q` | Close |

**Details view**

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate fields |
| `Enter` | Edit text fields / cycle enum fields |
| `d` | Toggle done |
| `o` / `s` / `c` | Same as list view |
| `Esc` / `q` | Back to list |

## Persistence

Tasks are stored in `~/.config/todo/` as per-scope JSON files:

```
~/.config/todo/
├── pedroklein__dotfiles.json   # repo-specific tasks
├── global.json                 # personal tasks
├── reviews.json                # PR reviews
└── work.json                   # work tasks
```

This is the same storage used by the [`todo` CLI](https://github.com/PedroKlein/tools/tree/main/cmd/todo) — they share the same data. You can use the standalone TUI (`todo`) to manage tasks from the terminal, and this extension to manage them from inside pi. Changes made in either are immediately visible to the other.

IDs are per-scope (each scope has its own 1-based numbering).

Migrates automatically from the old single-file format at
`~/.pi/agent/todo/pi-todo.json` on first run.

## GitHub integration

Supports GitHub.com and GitHub Enterprise. Token discovery order:
1. `gh auth token` (GitHub CLI)
2. `GITHUB_TOKEN` env var
3. `GH_TOKEN` env var
4. Unauthenticated (rate-limited to 60 req/hr)

GitHub Enterprise URLs (`https://github.yourcompany.com/...`) are detected
automatically from the PR URL host.

## Configuration

No required configuration — works out of the box with git repos.

**Optional integrations:**

- `@pedroklein/pi-baml` — enables BAML tier for AI task capture and PR review summaries. Install separately:
  ```bash
  pi install npm:@pedroklein/pi-baml
  ```

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
