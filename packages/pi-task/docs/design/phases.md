# Phase entity — design note

**Status**: draft (P1.1)
**Depends on**: nothing shipped yet — this is the shape the rest of Phase 1 builds against.
**Read alongside**: `design-briefs/plan-tasks-executor-field.md`, `design-briefs/plan-tasks-broader-learnings.md`.

## Problem

Today, "phase" exists only as a naming convention. Users write `P1.1`, `P2.3`, etc., and the tool has no idea which tasks belong together. Consequences observed in the wafer-poc plan (73 tasks, 3 sessions):

1. **No shared acceptance criteria per phase.** ACs live on individual tasks. A phase like "Phase 3: coupling" has an implicit meaning ("the bridge module works, cross-package coupling is clean") that no artifact captures. Verification runs on the last task, not the phase.
2. **No shared defaults.** Every task in a phase repeats the same `executor`, `parallelGroup` prefix, or `references.skills` list. Copy-paste drift is inevitable.
3. **No phase-level gate.** Phase 2 "starting" is emergent — the first ready P2 task. Nothing prevents starting P2.1 while a critical P1 task is still `in-progress`.
4. **Test gates are per-task, not per-phase.** Users bolt on `PN.z` marker tasks (the trick used in this very plan) to force a phase-end checkpoint. A first-class concept would remove the workaround.

## Approach

Add a `Phase` object. It sits between the plan and its tasks. Tasks reference a phase by `phaseId`. Phases form their own DAG. Existing plans (which have no phases) get an implicit `_root` phase automatically — the migration is a no-op.

## Entity shape

```ts
export interface Phase {
    /** Human-readable, plan-scoped unique ID. Example: "P1", "docs", "release". */
    id: string;
    title: string;
    description: string;
    /** Sort order for display and default execution ordering. */
    order: number;
    /** Phase-level DAG. Referenced phases must exist in the same plan. */
    dependsOn: string[];
    /** Phase-level acceptance criteria — verified by phase-verify, distinct from task ACs. */
    acceptanceCriteria?: string[];
    /**
     * Default executor for tasks in this phase. A task's own executor field
     * overrides. See executor-field brief for the cascade rules.
     */
    executor?: TaskExecutor;
    /** Defaults inherited by tasks in this phase (see cascade below). */
    defaults?: PhaseDefaults;
    /** Freeze the phase's ACs — same lock semantics as PlanTask.frozen. */
    frozen?: boolean;
    /** Phase-scoped annotations (parallel to TaskAnnotation, distinct target). */
    annotations: PhaseAnnotation[];
}

export interface PhaseDefaults {
    executor?: TaskExecutor;
    parallelGroup?: string;
    referenceSkills?: string[];
}

export interface PhaseAnnotation {
    timestamp: number;
    text: string;
    /** Optional structured category. Divergence-tracking is the primary use case. */
    category?: "divergence" | "risk" | "note";
}
```

`PlanTask` gains one field:

```ts
export interface PlanTask {
    // ...existing fields...
    /** Phase this task belongs to. Absence means implicit `_root` phase. */
    phaseId?: string;
}
```

`PlanGraph` gains one field and one convention:

```ts
export interface PlanGraph {
    // ...existing fields...
    phases?: Phase[];
    /** Plan-level defaults, one cascade tier below phase defaults. */
    defaults?: PlanDefaults;
}
```

## The `_root` implicit phase

Every plan has an implicit `_root` phase whether declared or not. Rules:

- If `graph.phases` is missing or empty, a synthetic `_root` phase is materialised on read with `{id: "_root", title: "Root", order: 0, dependsOn: []}`.
- Tasks with `phaseId === undefined` belong to `_root`.
- The `_root` ID is reserved — user-defined phases cannot use it.
- Old plans (like the wafer-poc plan with 73 phase-less tasks) round-trip through load-save without a shape change on disk. `_root` is a read-time computation, not a persisted entity.

This is the back-compat contract that P1.5's regression fixture will lock in.

## Task ↔ Phase relationship

- `phaseId` is optional on `PlanTask`. Absence means `_root`.
- Referential integrity: a task's `phaseId` must match an existing phase's `id` (or be undefined/`_root`). Enforced by `validatePlanGraph`.
- Deleting a phase referenced by any task is rejected. Users must move or delete the tasks first. This mirrors foreign-key semantics with no cascade.
- A task's dependencies (`dependsOn`) stay task-scoped. Cross-phase task dependencies are legal — a phase-3 task can depend on a phase-1 task.

## Phase DAG

Phases form a DAG independent of the task DAG.

- `phase.dependsOn` lists other phase IDs.
- `_root` has no dependencies and is implicitly satisfied.
- Cyclic phase graphs are rejected by `validatePlanGraph` — the tracer-bullet test for this task.

Phase readiness is derived from phase-task counts (added in P2):
- **pending**: at least one task in the phase is not `done`/`skipped`
- **ready**: all phase dependencies satisfied, at least one task is `ready`
- **in-progress**: at least one task is `in-progress`
- **done**: all tasks in the phase are `done` or `skipped`

Explicit note: a phase transitions to `done` **without a verify call** if no verify was requested. This preserves the opt-in guarantee in the verify design (`P3.6`). Auto-verification would break short-plan usage.

## Gate semantics

- A phase is a **soft** gate — you can `start` a task in phase P2 while P1 is still `in-progress`. The tool warns; it does not block. This preserves speed for planners who know what they're doing.
- A phase is a **hard** gate only when `phase.frozen === true` and a P1 task's ACs are not met. In that state, `start` on downstream-phase tasks is rejected with an error naming the unmet criteria.
- Test-gate tasks (the `PN.z` pattern) remain the recommended way to enforce a hard checkpoint. Phases add structure; they don't replace the discipline.

## Executor cascade

Resolution order for a task's effective executor, from lowest to highest priority:

```
plan.defaults.executor  →  phase.defaults.executor  →  phase.executor  →  task.executor
```

If none is set at any level, the fallback is `"any"`. See `design-briefs/plan-tasks-executor-field.md` for the five values and their meanings.

`phase.executor` and `phase.defaults.executor` may seem redundant. They aren't:
- `phase.executor` is the phase's own executor for phase-verify runs. Reviewers spawn under this executor.
- `phase.defaults.executor` is a shortcut for setting a common task executor across the phase — one line instead of N.

## Non-goals for this task

- **No phase actions** (`phase-create`, `phase-update`, `phase-delete`, `phase-status`). Data model only. Actions come in P2.1.
- **No migration** of the current pi-task-v-next plan or the wafer-poc plan. P1.5 handles the back-compat fixture.
- **No phase-verify** implementation. Design lives in `docs/design/verify.md` (P3.6); code in P3.6b.
- **No UI/widget** changes. P6.1 handles rendering.

## Constraints

- **Additive only** — `PlanTask`'s existing fields keep their shape and semantics. `phaseId` is optional.
- **Human-readable IDs** — no auto-UUIDs. Phase IDs are chosen by the plan author for legibility (`P1`, `docs`, `release`).
- **`_root` reserved** — user-defined phases with `id === "_root"` are rejected.

## Open questions (deferred, not blockers)

1. Should `phase-status` include a per-phase readiness summary that respects the executor cascade? Probably yes — decide in P2.1.
2. Should a phase's `annotations` bubble into the plan-level view when computed by `formatPlanGraphText`? Probably yes for `category: "divergence"` — decide in P6.5 (docs) once we see how the widget renders phases.
3. Should `bulk-complete` accept a phase ID as a shorthand? Nice-to-have — deferred.
