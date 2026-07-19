# pi-task

Task graph manager for pi. Provides the `plan_tasks` tool for creating and tracking implementation DAGs, a `/task` TUI for browsing plans interactively, and automatic plan context injection into every agent turn.

I built this to keep implementation work structured across sessions. The agent can see what's done, what's ready, and what's blocked — and the plan survives context resets.

## Install

```bash
pi install npm:@pedro_klein/pi-task
```

## Documentation

pi-task's documentation follows [Diataxis](https://diataxis.fr) — split by
what the reader is trying to do.

## Reference

Authoritative API and field docs. Read when you know what you want and need the exact shape.

- [`docs/reference/plan-tasks-actions.md`](docs/reference/plan-tasks-actions.md) — every `plan_tasks` action with params/returns/errors.

## Explanation

Concept docs. Read when you want to understand phases, executor cascade, or defaults.

- [`docs/explanation/phases-and-executors.md`](docs/explanation/phases-and-executors.md) — phases, the executor cascade, defaults, divergence, and verify.

## How-to

Task recipes. Read when you have a specific job and need the ordered steps.

- [`docs/how-to/author-multi-phase-plan.md`](docs/how-to/author-multi-phase-plan.md) — build a multi-phase plan end-to-end with the new tooling.

## Skills

Two skills ship with this package. Load them when the domain matches.

- [`skills/planning/SKILL.md`](skills/planning/SKILL.md) — DoD-aware planning methodology (acceptance criteria, phases, executor).
- [`skills/building/SKILL.md`](skills/building/SKILL.md) — the build-mode execution loop (start, complete, annotate, handoff).

## What it provides

**Tools:**

- `plan_tasks` — create and manage task graphs and phases (see [Reference](docs/reference/plan-tasks-actions.md) for every action).

**Commands:**

- `/task` — open the interactive task browser (plans list + task detail view).
- `/spdd-sync [path]` — sync implementation back to a source REASONS Canvas.
- `/plan-import-openspec [change]` — import tasks from an OpenSpec `tasks.md` file.
- `/plan-export-openspec <change>` — export the active plan to OpenSpec format.

**Events (injected into system prompt):**

- Active plan progress, next task, TDD notes, and parallel group hints are injected before every agent turn.

**Status bar:**

- Publishes a `📋 done/total → next-task` segment via `pi-status:register`.
