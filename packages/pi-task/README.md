# pi-task — Task Management Extension

Extension providing the `plan_tasks` tool, `/task` interactive TUI, and OpenSpec integration for managing implementation task graphs.

Uses **pi-task-lib** for plan data operations and persistence.

## Commands

| Command | Description |
|---------|-------------|
| `/task` | Open interactive task browser (plans, tasks, annotations) |
| `/spdd-sync [path]` | Sync code changes back to source REASONS Canvas |
| `/plan-import-openspec [change]` | Import tasks from OpenSpec `tasks.md` |
| `/plan-export-openspec <change>` | Export plan to OpenSpec `tasks.md` format |

## `plan_tasks` Tool

The agent uses this tool to create and manage structured task DAGs.

| Action | Description |
|--------|-------------|
| `create` | Create a new plan with tasks + sub-tasks |
| `update` | Modify task fields (title, deps, files, tddNotes) |
| `status` | Return full graph with computed ready/blocked states |
| `expand` | Add sub-tasks to an existing task |
| `get` | Get details of a specific task |
| `complete` | Mark a task or sub-task as done |
| `skip` | Mark a task or sub-task as skipped |
| `delete` | Remove a task or sub-task |
| `reorder` | Change task execution order |
| `annotate` | Add a note to a task |
| `update-subtask` | Modify sub-task fields |
| `list-plans` | List all plans |
| `switch-plan` | Switch active plan |
| `archive` | Archive a plan |
| `diff` | Show plan changes since last revision |

## Task Browser (`/task`)

Interactive TUI with two views:

**Plan list:**
- Browse plans with progress, active marker (★), status
- `Enter` to switch, `x` to archive, `t` for task view

**Task view:**
- Tasks with status icons (✅ 🔓 🔒 ⏭ ⚙ ⏳)
- Dependency tree and file expectations
- `a` to annotate, `d` for diff, `p` for plan list, `Esc` to close

## System Prompt Integration

Injects active plan context (progress, active task, TDD notes) into the system prompt on every agent turn.

## Files

- **index.ts** — tool registration, commands, system prompt injection, plan state management
- **plan-widget.ts** — interactive TUI component for `/task`

Data layer is in **pi-task-lib/**. pi-task publishes plan progress to the context bar via `pi-status:register` events.
