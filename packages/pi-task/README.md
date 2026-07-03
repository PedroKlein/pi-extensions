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

**Two-level hierarchy:**
- `PlanTask` — feature-level task with `id`, `title`, `description`, `order`, `dependsOn`, `files`, `tddNotes`, `parallelGroup`
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
| `status` | — | Return the full graph with computed ready/blocked states |
| `get` | `taskId` | Get details of one task (deps, files, TDD notes, sub-tasks, annotations) |
| `update` | `taskId`, `updates` | Modify task fields: title, description, dependsOn, files, tddNotes, parallelGroup, order |
| `expand` | `taskId`, `newSubtasks[]` | Add sub-tasks to an existing task |
| `complete` | `taskId` | Mark task done (cascades to non-terminal sub-tasks). Pass `subtaskId` to complete one sub-task. |
| `skip` | `taskId` | Mark task skipped. Pass `subtaskId` to skip one sub-task. |
| `delete` | `taskId` | Remove task (cleans up dependsOn references). Pass `subtaskId` to delete one sub-task. |
| `reorder` | `taskId`, `updates.order` | Change task position in the sorted display order |
| `update-subtask` | `taskId`, `subtaskId`, `updates` | Modify sub-task title or description |
| `annotate` | `taskId`, `text` | Add a timestamped note to a task |
| `diff` | — | Show what changed since last plan revision |
| `list-plans` | — | List all plans with progress and active marker |
| `switch-plan` | `planName` | Switch the active plan (auto-unarchives if archived) |
| `archive` | `planName` | Archive a completed plan |
| `unarchive` | `planName` | Restore an archived plan |

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
