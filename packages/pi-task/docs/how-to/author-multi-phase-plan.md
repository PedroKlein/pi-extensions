# How to author a multi-phase plan

Assumes you know what a plan and a phase are — if not, read
[Explanation → Phases & Executors](../explanation/phases-and-executors.md) first.

This walkthrough follows the same shape as the
[dogfood recording](../../tests/e2e/pi-task-v-next-dogfood.md), which was captured
end-to-end during pi-task v-next development. Following these steps takes any
fresh checkout of a repo to the same end state.

## 1. Create the plan with a scratch directory

```
plan_tasks create --planName my-refactor \
  --scratchDir /tmp/plans/my-refactor/scratch \
  --tasks '[{"id":"TT.SEED","title":"seed","description":"placeholder for first phase-add","order":0}]'
```

If you omit `scratchDir`, pi-task defaults to `<plansRoot>/<planName>/scratch/` and
creates the directory. Either way, `create` guarantees the directory exists before
returning.

## 2. Define phases with their own defaults

```
plan_tasks phase-create --phase '{
  "id":"P1",
  "title":"Design",
  "description":"ADRs and schema freeze",
  "order":1,
  "acceptanceCriteria":["AC: ADR-014 merged."],
  "defaults":{"executor":"inline","referenceSkills":["go-dev"]}
}'

plan_tasks phase-create --phase '{
  "id":"P2","title":"Migration","order":2,"dependsOn":["P1"],
  "defaults":{"referenceSkills":["go-sqlc"]}
}'

plan_tasks phase-create --phase '{
  "id":"P3","title":"Audit","order":3,"dependsOn":["P2"],
  "acceptanceCriteria":["AC: Two reviewers confirm no coverage regression."],
  "defaults":{"executor":"subagent-fresh"}
}'
```

Each `phase.defaults.executor` cascades to every task in that phase unless the task
overrides. Phase-level ACs are what `phase-verify` audits against.

## 3. Add tasks with executor and phaseId

```
plan_tasks add --tasks '[
  {"id":"P1.1","title":"Draft ADR skeleton","description":"outline the decision","order":1,
   "phaseId":"P1"},
  {"id":"P1.2","title":"Stakeholder approvals","description":"interview and lock","order":2,
   "phaseId":"P1","executor":"user","dependsOn":["P1.1"]},
  {"id":"P2.1","title":"Write goose migration","description":"add events table","order":3,
   "phaseId":"P2","dependsOn":["P1.2"]},
  {"id":"P3.1","title":"Coverage audit","description":"fresh-context reviewer","order":4,
   "phaseId":"P3","parallelGroup":"audit-fresh","dependsOn":["P2.1"]},
  {"id":"P3.2","title":"Rollback audit","description":"fresh-context reviewer","order":5,
   "phaseId":"P3","parallelGroup":"audit-fresh","dependsOn":["P2.1"]}
]'
```

Every task inherits its phase's `executor` unless it overrides. P1.2 overrides to
`user` (approvals). P3.1 and P3.2 inherit `subagent-fresh` and share
`parallelGroup: "audit-fresh"` so the runtime can fan them out safely.

## 4. Append acceptance criteria to a phase

```
plan_tasks phase-ac --phaseId P2 --criteria '[
  "AC: goose up | goose down is idempotent.",
  "AC: sqlc types regenerated cleanly."
]'
```

Rejected once the phase is frozen. Fine to run repeatedly before freeze.

## 5. Freeze a phase when its ACs are stable

```
plan_tasks phase-freeze --phaseId P1
```

Freezing locks the phase's acceptance criteria. Further `phase-ac` calls on P1
are rejected until `phase-unfreeze`. You typically freeze phases in stages as they
solidify.

## 6. Start a task — plan freezes implicitly on the first call

```
plan_tasks start --taskId P1.1
```

The first `start` on any task sets `plan.frozen = true`. Every task's ACs become
immutable. `add-criteria` and `update` for ACs are rejected until you explicitly
unfreeze.

If P1.1's resolved executor were `user`, `start` returns
`{ blocked: true, reason: "awaiting-user" }`. If it were `subagent-fresh` and the
session budget was exhausted, it returns
`{ blocked: true, reason: "subagent-budget-exhausted", escalation: {...} }`. For
`inline` or `any`, `start` proceeds.

## 7. Complete a task — including divergence

Ordinary path — task is `in-progress`:

```
plan_tasks complete --taskId P1.1
```

Un-started path — task went from `ready` straight to `done`. Divergence required:

```
plan_tasks complete --taskId P1.1 --divergence "resolved by prior refactor in commit abc123"
```

The divergence text is auto-appended as a `category: divergence` annotation, and
the task earns a ⚠️ badge in `plan_tasks status` output.

## 8. Annotate an in-flight divergence

Halfway through a task you notice the AC was subtly wrong. Record it, then
continue:

```
plan_tasks annotate --taskId P2.1 --category divergence \
  --text "Used WithDeadline per repo convention; AC said WithTimeout — stale."
```

`category` accepts `note`, `divergence`, `blocker`, `decision`. Runtime auto-emissions
always use `divergence`.

## 9. Run phase-verify (optional)

When a phase is done and you want an independent panel to weigh in:

```
plan_tasks phase-verify --phaseId P2 --reviewers 4
```

Four reviewers (completeness / correctness / safety / quality) run in fresh contexts
and produce a synthesised verdict. Report lands at
`${scratchDir}/verify/P2/<iso-timestamp>.md`. If verdict is `fail`, override with:

```
plan_tasks phase-verify --phaseId P2 --override --reason "shipping under time pressure; findings tracked in ADR-014."
```

When the pi-subagents bridge is unavailable, `phase-verify` returns
`{ unavailable: true, reason, verdict: "unknown" }` and writes no report. It does not
fabricate a verdict.

## 10. Confirm the end state

```
plan_tasks status
```

Success — the render shows each phase header with `N/M done` counts, executor and
frozen badges, and per-task rows with executor / divergence / blocker markers. Every
task in every phase is `done`. The plan itself shows `Plan: 🧊 frozen` and the
`spawns:` line reports actual figures or `probe-unavailable`. This is the same end
state as the [dogfood recording](../../tests/e2e/pi-task-v-next-dogfood.md).
