# Concurrency: load-mutate-save race in `plan_tasks`

**Status**: draft (P1.7)
**Scope**: fixes a real bug observed while authoring the `pi-task-v-next` plan.

## What happened

While authoring the plan, four `plan_tasks update` calls were issued in a single agent tool-call block, each targeting a different task and setting a distinct `dependsOn`. All four calls returned `Task X updated.`. Reading the plan file afterwards showed **only the last call's change had persisted** — the other three were silently lost.

## Root cause

Inside `piTask()`, every mutating action follows the same pattern:

```ts
case "update": {
    const prevGraph = savePreviousRevision(activePlan);   // ① read
    const updated = updateTask(prevGraph, ...);           // ② transform (pure)
    const errors = validatePlanGraph(updated);            // ③ validate
    await saveAndRefreshPlan(updated);                    // ④ save + updates activePlan
    return { ... };
}
```

The `activePlan` variable is the in-memory source of truth between calls. When two or more actions fire in the same tick:

- Both enter their case block and each executes step ① against the **same** `activePlan` snapshot.
- Each builds its own `updated` graph — but each is derived from the pre-race snapshot, unaware of the other's mutation.
- Both call `saveAndRefreshPlan(updated)` at ④. The last write wins, silently.

This is a **load-mutate-save race** — a classic read-after-write coordination bug. The disk write is atomic (`writeFileSync`), but there's no serialization across the load→save round-trip, so the effective isolation is nil.

## Why it wasn't caught

- Each `saveAndRefreshPlan` succeeds and returns `true` — no error surfaces.
- The tool response for every call is `Task X updated.` — deterministic and misleading.
- The regression suite tests each mutation individually, not concurrent mutations.
- Real agent workflows rarely fire parallel `plan_tasks update` before this iteration of the pi-task-v-next plan, so the bug lay dormant.

## Fix approach

Introduce a per-plan-name async mutex. All mutating case blocks acquire the mutex, run their read-transform-validate-save critical section under it, and release. The mutex is keyed by plan name so unrelated plans don't contend, and it lives in-process (this extension is single-process per pi session).

Rejected alternatives:

- **Disk-level file lock (flock/lockfile).** Adds a filesystem dependency, complicates test setup, and buys nothing over an in-process mutex given pi-task runs in a single process.
- **Optimistic concurrency with version tokens.** Requires schema change (a `version` field) and error-handling in every caller. Overkill for the actual workload — mutations from one process serialize cheaply.
- **Reload from disk at the start of every mutation.** Doesn't help alone — two callers both reload the same stale disk state simultaneously. Would still race on the save side.

## Design

### `src/plan-mutex.ts`

Exposes one primitive:

```ts
export async function withKeyedMutex<T>(key: string, fn: () => Promise<T>): Promise<T>
```

- FIFO queue per key.
- Acquisition is a promise that resolves when the key is free.
- Release is guaranteed via a `finally` block — exceptions in `fn` do not deadlock the queue.
- No timeouts. If a caller wedges, the queue wedges. Simple; observable.

### Integration in `piTask()`

A single `mutateActivePlan(computeMutation)` helper wraps the critical section:

```ts
async function mutateActivePlan(
    computeMutation: (graph: PlanGraph) => PlanGraph,
): Promise<PlanGraph> {
    if (!activePlan) throw new Error("No active plan");
    const key = activePlan.name;
    return withKeyedMutex(key, async () => {
        if (!activePlan) throw new Error("No active plan");
        const mutated = computeMutation(activePlan);
        const errors = validatePlanGraph(mutated);
        if (errors.length > 0) throw new Error(...);
        await saveAndRefreshPlan(mutated);
        return mutated;
    });
}
```

Every mutating case (`add`, `update`, `start`, `complete`, `skip`, `bulk-*`, `annotate`, `expand`/`add-subtasks`, `freeze`, `unfreeze`, `reorder`, `delete`, `add-criteria`, `update-subtask`) migrates to call this helper.

## Non-goals

- **Cross-process coordination.** pi-task runs in a single process per pi session; two sessions running against the same plan file is out of scope. If needed later, a disk lock is the mitigation, but no evidence of the case exists yet.
- **Fine-grained locking.** The mutex serializes ALL mutations on a plan, not per-task. A future task-level lock is possible but adds complexity without clear evidence of contention beyond the parallel-update workflow.
- **Waiting-caller telemetry.** No metrics on lock wait times in this iteration. If we later observe long queues, add a counter then.

## Verification

The regression test at `tests/unit/plan-concurrency.test.ts` fires N parallel mutations on distinct tasks and asserts all N changes persist to disk. Pre-fix this test FAILs; post-fix it PASSes — that's the tracer bullet.
