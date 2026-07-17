# pi-task

Task graph manager for pi. Provides the `plan_tasks` tool for creating and tracking implementation DAGs, a `/task` TUI for browsing plans interactively, and automatic plan context injection into every agent turn.

I built this to keep implementation work structured across sessions. The agent can see what's done, what's ready, and what's blocked — and the plan survives context resets.

## Install

```bash
pi install npm:@pedro_klein/pi-task
```

## What it provides

**Tools:**
- `plan_tasks` — create and manage task graphs (see [Actions](#plan_tasks-actions) below)

**Commands:**
- `/task` — open the interactive task browser (plans list + task detail view)
- `/spdd-sync [path]` — sync implementation back to a source REASONS Canvas
- `/plan-import-openspec [change]` — import tasks from an OpenSpec `tasks.md` file
- `/plan-export-openspec <change>` — export the active plan to OpenSpec format

**Events (injected into system prompt):**
- Active plan progress, next task, TDD notes, and parallel group hints are injected before every agent turn

**Status bar:**
- Publishes a `📋 done/total → next-task` segment via `pi-status:register`

## Task model

Tasks form a **DAG** (directed acyclic graph):

```
task-a (ready)
task-b (blocked — depends: task-a)
task-c (blocked — depends: task-a)
task-d (blocked — depends: task-b, task-c)
```

**Typical workflow:**
```
create  →  plan with initial tasks
add     →  append more tasks as scope becomes clear
start   →  mark a task in-progress
complete/skip  →  finish tasks (bulk-complete for batches)
add-subtasks   →  break a task into TDD-sized sub-tasks
annotate       →  leave notes during implementation
archive        →  archive when done
```

**Two-level hierarchy:**
- `PlanTask` — feature-level task with `id`, `title`, `description`, `order`, `dependsOn`, `files`, `tddNotes`, `parallelGroup`, `references`, `acceptanceCriteria`, `nonGoals`, `frozen`
- `PlanSubtask` — TDD-sized sub-task within a task, with optional `tddBehavior`

**Status lifecycle:**
```
pending → ready (when all deps done) → in-progress → done
         ↓
       blocked (when any dep not done)
         ↓
       skipped
```

**Parallel groups:** tasks with the same `parallelGroup` string and no file conflicts can run concurrently. The system prompt surfaces them as a group so the agent can delegate to worker subagents.

## `plan_tasks` actions

| Action | Required params | Description |
|--------|----------------|-------------|
| `create` | `planName`, `tasks[]` | Create a new plan. Tasks are validated for cycles and duplicate IDs. |
| `add` | `tasks[]` | **Append new tasks to the active plan.** Validates IDs don't conflict with existing tasks. |
| `status` | — | Return the full graph with computed ready/blocked states |
| `get` | `taskId` | Get details of one task (deps, files, TDD notes, sub-tasks, annotations) |
| `start` | `taskId` | **Mark task as in-progress.** Signals work has begun. |
| `update` | `taskId`, `updates` | Modify task fields: title, description, dependsOn, files, tddNotes, parallelGroup, order |
| `add-subtasks` | `taskId`, `newSubtasks[]` | Add sub-tasks to an existing task (alias: `expand`) |
| `expand` | `taskId`, `newSubtasks[]` | _Alias for `add-subtasks`_ |
| `complete` | `taskId` | Mark task done (cascades to non-terminal sub-tasks). Pass `subtaskId` to complete one sub-task. |
| `skip` | `taskId` | Mark task skipped. Pass `subtaskId` to skip one sub-task. |
| `bulk-complete` | `taskIds[]` | **Mark multiple tasks done at once.** Cascades to sub-tasks. |
| `bulk-skip` | `taskIds[]` | **Mark multiple tasks skipped at once.** |
| `delete` | `taskId` | Remove task (cleans up dependsOn references). Pass `subtaskId` to delete one sub-task. |
| `reorder` | `taskId`, `updates.order` | Change task position in the sorted display order |
| `update-subtask` | `taskId`, `subtaskId`, `updates` | Modify sub-task title or description |
| `freeze` | `taskId` (optional) | **Lock acceptance criteria immutable.** Prevents modification until unfreeze. Used before implementation to create a verification contract. |
| `unfreeze` | `taskId` | **Unlock frozen criteria.** Only do this for genuine requirement changes. |
| `add-criteria` | `taskId`, `criteria[]` | **Add acceptance criteria to a task.** Format: `AC: [observable]. Verify: [how to check].` |
| `annotate` | `taskId`, `text` | Add a timestamped note to a task |
| `diff` | — | Show what changed since last plan revision |
| `list-plans` | — | List all plans with progress and active marker |
| `switch-plan` | `planName` | Switch the active plan (auto-unarchives if archived) |
| `archive` | `planName` | Archive a completed plan |
| `unarchive` | `planName` | Restore an archived plan |
| `delete-plan` | `planName` | **Permanently delete a plan** (removes files from disk) |

## Acceptance Criteria & Verification

Tasks can carry acceptance criteria and references that integrate with [pi-verify](../pi-verify) for independent verification.

```json
{
  "id": "auth-endpoint",
  "title": "Implement auth endpoint",
  "acceptanceCriteria": [
    "AC: POST /auth/login returns JWT on valid credentials. Verify: curl with valid user returns 200 + token.",
    "AC: Invalid credentials return 401. Verify: curl with bad password returns 401 + error body."
  ],
  "references": {
    "skills": ["go-dev", "go-testing"],
    "files": ["internal/auth/handler.go", "docs/adr/003-auth.md"],
    "memory": ["project.auth.design"]
  },
  "nonGoals": ["Not implementing refresh tokens yet"],
  "frozen": true
}
```

**Workflow with pi-verify:**
1. `plan_tasks add-criteria` adds testable criteria per task
2. `plan_tasks freeze` (or `/freeze`) locks criteria immutable
3. Build the implementation
4. `/verify` spawns 4 blind reviewers who check work against the frozen contract

**References** tell the implementing agent what to load before writing code:

| Field | What it points to |
|-------|-------------------|
| `skills` | Domain skills (e.g., `["go-dev", "coding-discipline"]`) |
| `files` | Source files, configs, ADRs to read first |
| `repos` | External repos with relevant patterns |
| `docs` | Specs, RFCs, external documentation URLs |
| `memory` | Memory keys holding project decisions |

**nonGoals** prevent scope creep by making boundaries explicit.

**frozen** marks criteria as locked. Frozen criteria reject updates until `unfreeze` is called.

## Skills

pi-task ships a **planning** skill that teaches agents acceptance criteria format, references structure, planning granularity decisions, and criteria sharpening techniques. Auto-discovered on install.

## TDD integration

Each task has a `tddNotes` field (guidance for what to test first). Each sub-task has a `tddBehavior` field (one specific test scenario). Both are surfaced in the system prompt when a task is active, so the agent knows what to write tests for before implementing.

Example:

```json
{
  "id": "store-crud",
  "title": "Implement store CRUD",
  "tddNotes": "Write failing tests for add/get/remove before touching the store",
  "subtasks": [
    { "id": "store-add", "title": "add()", "tddBehavior": "adding a fact returns it in search" },
    { "id": "store-remove", "title": "remove()", "tddBehavior": "removed fact no longer appears in search" }
  ]
}
```

## Plan persistence

Plans are stored under `~/.pi/plans/<repo-slug>/`:

```
~/.pi/plans/
  pedroklein-my-project/
    active.json              ← { planName, updatedAt }
    active-<worktree>.json   ← per-worktree active ref
    plans/
      my-plan-name/
        plan.json            ← full PlanGraph
```

The repo slug is derived from `git remote get-url origin` (e.g. `org/repo` → `org-repo`). Falls back to the git root basename, then `global`.

Worktree support: each worktree can have its own active plan ref, so you can track different plans across branches.

## Configuration

No configuration required — plans are stored automatically under `~/.pi/plans/`.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
