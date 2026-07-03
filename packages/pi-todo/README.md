# pi-todo

Terminal-first TODO extension for Pi with AI-powered task capture, PR review tracking, and AI review actions.

## Features

- **Startup snapshot**: Multi-column board grouped by task type
  - Branded header banner with counters (`╭─ 📋 TODO ─── 3 open · 1 overdue ─╮`)
  - Type icons: 🚀 Feature, 🐛 Bug, 🔧 Chore, 🔬 Research, 👀 Review, 👤 Personal
  - Priority dots: `●` high, `◦` medium, `·` low
  - Blocked marker: `⚠` shown only for blocked tasks
  - Due date badges: `3d`, `today`, `2d!` (color-coded by urgency)
  - Rounded corners with accent-colored borders
  - Framed empty and all-done states
  - Stacked fallback for narrow terminals
  - **Displayed visually but filtered from LLM context** (zero token cost)
- **Interactive board**: Centered overlay modal (`/todo` or `Ctrl+Shift+B`)
  - Single-type view with vim-style navigation (h/l switch type, j/k tasks)
  - Field-by-field inline editing in details panel
  - Read-only repo field in details view
  - Repo tag shown per task in all-repos scope
  - PR metadata and actions section for review tasks
  - Open URLs with `o` key
  - Status filter cycling, repo scope toggle
  - Delete tasks with `x`, toggle done with `d`
- **AI capture**: Natural language → structured task with loading indicator
  - `/todo Fix the auth bug by next Friday` → parses into title, type, priority, due date, description
  - Uses Pi's current LLM provider with current date context for accurate date resolution
  - Preview modal before saving with inline field editing (Save / Discard)
  - Heuristic fallback when LLM is unavailable
  - AI-generated concise 2-3 sentence description from brain dump input
- **PR review tracking**: `/todo <pr-url>` creates a review task
  - Detects GitHub and GitLab PR/MR URLs (including GitHub Enterprise)
  - Fetches PR metadata via GitHub API (title, author, state, branch)
  - Token discovery: `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`
  - Falls back to URL parsing if API unavailable
  - Review tasks are always global (visible in all repos)
- **AI review actions** (from the board, on review tasks):
  - **`s` — AI Summary**: Fetches diff via `gh pr diff`, generates a structured review (What / Why / Scope / Risks / Verdict), shown in a modal with inline Q&A follow-ups
  - **`o` — Open in browser**: Opens the PR URL
  - **`c` — Clone & Review**: Clones the repo to `/tmp/pi-review-*/`, opens a new pi session with the diff injected, AI auto-generates a full file-by-file review
- **AI tool**: `todo` tool for LLM to read/write tasks (only way todos enter context)
  - Actions: `list`, `add`, `update`, `complete`, `delete`
  - Scoped to current repo or all repos
- **Status bar**: Open task count shown in footer (non-context, purely visual)
- **Repo-scoped tasks**: Auto-detected from git remote origin (org-repo slug)
  - Personal tasks go to `global/` scope, review tasks go to `reviews/` scope
  - Other task types go to `<org>-<repo>/` scope
  - IDs are per-scope (each scope numbers independently from 1)
- **Split-file persistence** under `~/.pi/todo/`
  - `<org-repo>.json` — repo-scoped tasks
  - `global.json` — personal tasks
  - `reviews.json` — review tasks (work-related, separately gitignored)

## Task Model

| Field | Values |
|-------|--------|
| title | string |
| type | feature / bug / chore / research / review / personal |
| status | open / blocked / done |
| priority | low / medium / high |
| due date | YYYY-MM-DD (optional) |
| description | AI-generated concise summary (optional) |
| url | URL associated with the task (optional, used by review tasks) |
| prMeta | PR metadata: title, author, state, branch, host, owner, repo, number (optional) |
| note | string (optional) |
| repoId | auto-detected slug ("global" for personal, "reviews" for review types) |

**No lanes** — the board groups tasks by type. Due dates handle all time-based urgency via color coding.

**Global types** — `personal` tasks are always scoped to `global/` and `review` tasks to `reviews/`. Both appear in the snapshot regardless of which repo you're working in. Changing a task's type to/from a global type auto-moves its repo scope and re-numbers its ID.

## Commands

| Command | Action |
|---------|--------|
| `/todo` | Open the interactive board (centered overlay) |
| `/todo <text>` | Create a task from natural language via AI parsing |
| `/todo <pr-url>` | Create a review task from a GitHub/GitLab PR URL |
| `/todo-repo` | Show current repo scope |
| `/todo-clone-review` | Internal: clone PR and open review session (triggered from board) |
| `Ctrl+Shift+B` | Open the board (keyboard shortcut) |

## AI Tool

The `todo` tool is callable by the LLM. It's the **only** way task data enters the LLM context window.

| Action | Description |
|--------|-------------|
| `list` | List tasks (repo-scoped or all) |
| `add` | Create a new task (supports url field) |
| `update` | Modify task fields |
| `complete` | Mark a task as done |
| `delete` | Remove a task |

## Board Keys

### List View

| Key | Action |
|-----|--------|
| `h/l` or `←/→` | Switch type tab |
| `j/k` or `↑/↓` | Move task selection |
| `Enter` | Open details view |
| `d` | Toggle done/open |
| `x` | Delete task |
| `o` | Open URL in browser (if task has a URL) |
| `s` | AI Summary modal (review tasks only) |
| `c` | Clone & Review session (review tasks only) |
| `n` | Annotate (jump to note field in edit mode) |
| `f` | Cycle status filter (active → open → blocked → done → all) |
| `Tab` | Toggle scope (current repo / all repos) |
| `r` | Refresh |
| `Esc` / `q` | Close board |

### Details View

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Navigate fields |
| `Enter` | Edit field (text) or cycle value (type/priority/status) |
| `o` | Open URL in browser |
| `s` | AI Summary modal (review tasks) |
| `c` | Clone & Review session (review tasks) |
| `d` | Toggle done/open |
| `Esc` / `q` | Back to list |

### AI Summary Modal

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Scroll content |
| `?` or `a` | Ask a follow-up question about the PR |
| `Esc` / `q` | Close modal |

## PR Review Workflow

### Quick review (AI Summary)
1. `/todo https://github.com/owner/repo/pull/123` — creates review task
2. Open board (`Ctrl+Shift+B`), navigate to 👀 Review tab
3. Press `s` — fetches diff, generates structured AI summary
4. Read the What / Why / Scope / Risks / Verdict sections
5. Press `?` to ask follow-up questions inline
6. Press `Esc` to close, `d` to mark as done

### Deep review (Clone & Review)
1. Same as above, but press `c` instead of `s`
2. Extension clones the repo to `/tmp/pi-review-*/`
3. Opens a new pi session in the cloned directory
4. AI auto-generates a comprehensive file-by-file review
5. Ask follow-up questions with full codebase access (grep, read files, run tests)
6. Use `/resume` to return to your original session

### Simple review
1. `/todo <pr-url>` — creates review task
2. Press `o` in the board to open PR in browser
3. Review manually, press `d` when done

## Supported URL Formats

- `https://github.com/owner/repo/pull/123`
- `https://github.example.com/owner/repo/pull/123` (GitHub Enterprise)
- `https://gitlab.com/owner/repo/-/merge_requests/123`

## Token & CLI Requirements

**PR metadata fetching** (on task creation):
1. `GH_TOKEN` environment variable
2. `GITHUB_TOKEN` environment variable
3. `gh auth token --hostname <host>` (GitHub CLI)

**AI Summary & Clone Review** (diff fetching):
- Requires `gh` CLI installed and authenticated (`gh auth login`)
- Uses `gh pr diff <number> --repo <owner/repo>`
- For GitHub Enterprise: automatically sets `GH_HOST=<host>` env var when invoking `gh`
- Authenticate GHE with `gh auth login --hostname github.example.com`

**Clone & Review** (repository cloning):
- Requires `git` CLI
- Clones to system temp directory (`/tmp/pi-review-*/`)
- For private repos: git must have access (SSH keys or credential helper)

## Context Strategy

The extension is designed to **never pollute the LLM context** automatically:

- **Startup snapshot** → displayed as a custom message, filtered out by the `context` event handler
- **Task preview modal** → overlay UI, never a message
- **AI Summary modal** → overlay UI, never a message
- **Status bar** → `setStatus()`, purely visual
- **Clone & Review** → opens a separate session, original session untouched
- **AI tool** → the only way task data enters context, and only when explicitly invoked

## Visual Language

| Symbol | Meaning |
|--------|---------|
| `●` | High priority |
| `◦` | Medium priority |
| `·` | Low priority |
| `⚠` | Blocked (only shown when blocked) |
| `3d` / `today` / `2d!` | Due date badge (dim/yellow/red) |
| 🚀 🐛 🔧 🔬 👀 👤 | Feature, Bug, Chore, Research, Review, Personal |

## Architecture

```
index.ts        Entry point: lifecycle, commands, shortcuts, AI capture, PR capture, tool, context filtering
model.ts        Task types, PR metadata, actions, urgency sorting, filtering, counters, global type handling
board.ts        Interactive overlay board UI with vim nav, details editing, PR info, and action keys
snapshot.ts     Multi-column kanban snapshot with icons, priority dots, due badges, branded header
capture.ts      LLM-based task parsing + heuristic fallback
github.ts       PR URL parsing, GitHub API fetch (supports GHE), token discovery, diff fetching, repo cloning
review.ts       AI summary modal with inline Q&A, clone & review session creation
persistence.ts  Split-file persistence under ~/.pi/todo/<scope>.json (with migration from old format)
```

## Design Decisions

- **No context pollution** — startup snapshot, previews, and AI summary modal are filtered from LLM context
- **AI tool for LLM access** — tasks only enter context when the AI explicitly calls the `todo` tool
- **Global types** — personal and review tasks are always global, auto-move repo on type change
- **PR reviews as first-class tasks** — own type, own icon, own section with metadata and AI-powered actions
- **AI summary = structured sections** — What / Why / Scope / Risks / Verdict format, with inline Q&A follow-ups
- **Clone & Review = new session** — clones to tmp, opens isolated pi session with diff context, AI auto-reviews
- **Extensible actions** — `REVIEW_ACTIONS` array in model.ts, easy to add new actions (diff view, CI check, etc.)
- **gh CLI for diffs** — simpler than raw API, handles auth automatically. For GHE hosts, `GH_HOST` env var is set automatically when invoking `gh`
- **No lanes** — type is the grouping dimension; due dates handle urgency via color coding
- **No tags** — type + priority + repo scoping provide enough categorization
- **No duplicate detection** — simple for v1, add later if needed
- **No subcommands** — `/todo` opens the board, `/todo <text>` or `/todo <url>` creates a task
- **Preview modal** — every AI-captured task is shown in a modal for review before saving
- **Description over first-step** — AI generates a concise summary instead of an actionable first step
- **Last-write-wins persistence** — no file locking or concurrency handling
- **Done tasks kept forever** — filtered by status, no auto-archiving
- **Blocked = simple flag** — no linked reason or dependency tracking
- **Task ordering** — urgency-first, then priority descending, then creation date
- **Current date in LLM prompt** — enables accurate relative date resolution ("next Friday")
- **Filter key changed to `f`** — `s` freed up for AI Summary action
