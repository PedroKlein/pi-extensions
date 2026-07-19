# pi-task v-next dogfood recording

Regression evidence for the v-next release. This recording captures the shape of a
multi-phase plan authored end-to-end with the new tooling. It is the source-of-truth
for the [How-to](../../docs/how-to/author-multi-phase-plan.md) walkthrough.

## Setting

Hypothetical project: adding a persistence layer with three phases (Design →
Migration → Audit). 20 tasks across the three phases, one deliberate un-started
completion to exercise the divergence path.

## Action checklist

Every P2 action was exercised at least once. Marked ✅ when demonstrated in this
recording.

- [x] ✅ `plan_tasks create` — with `scratchDir` set
- [x] ✅ `plan_tasks add` — batch of tasks with `phaseId` + `executor`
- [x] ✅ `plan_tasks phase-create` — three phases, each with `defaults`
- [x] ✅ `plan_tasks phase-update` — renamed P2 title mid-flight
- [x] ✅ `plan_tasks phase-status` — inspected P1 before freeze
- [x] ✅ `plan_tasks phase-ac` — appended two ACs to P2
- [x] ✅ `plan_tasks phase-freeze` — locked P1 after its work completed
- [x] ✅ `plan_tasks phase-unfreeze` — reopened P1 briefly to add one AC after user feedback
- [x] ✅ `plan_tasks phase-annotate` — recorded a decision annotation on P3
- [x] ✅ `plan_tasks phase-delete` — deleted an unused stub phase created earlier
- [x] ✅ `plan_tasks start` — proved implicit freeze on first call
- [x] ✅ `plan_tasks complete` — ordinary path + divergence path
- [x] ✅ `plan_tasks bulk-complete` — three trivially-symmetric rename tasks in one call
- [x] ✅ `plan_tasks annotate --category divergence` — recorded a mid-task divergence
- [x] ✅ `plan_tasks annotate --category blocker` — briefly blocked a task before pivoting
- [x] ✅ `plan_tasks update --updates.acceptanceCriteria` — pre-freeze AC edit (replaces deprecated add-criteria)
- [x] ✅ `plan_tasks freeze` / `unfreeze` — task-level lock demonstrated
- [x] ✅ `plan_tasks reorder` — moved P2.3 ahead of P2.2 after a dependency correction
- [x] ✅ `plan_tasks status` — verified phase groupings, executor badges, divergence badge
- [x] ✅ `plan_tasks get --verbose` — inspected resolved defaults cascade

## Divergence trigger — proof

One task (P2.4 "Update rollback playbook") was completed via the un-started path:

```
plan_tasks complete --taskId P2.4 \
  --divergence "AC covered by adjacent P2.3 rollback script; standalone playbook was redundant."
```

Result: task transitioned `ready → done`, a `category: divergence` annotation was
auto-appended, and the P2.4 line in `plan_tasks status` output now shows ⚠️ divergence.

## Session captures

Rendering excerpts (redacted timestamps):

```
# Plan: persistence-layer-refactor
Status: active | Tasks: 20/20 done | Ready: 0 | Blocked: 0
Plan: 🧊 frozen
scratchDir: /tmp/plans/persistence-layer-refactor/scratch

▸ Phase P1: Design — 5/5 done 🧊 [executor: inline]
  Phase AC (frozen):
    • AC: ADR-014 merged.
    • AC: schema-v2.sql frozen.
  ✅ P1.1: Draft ADR skeleton (done) 🧊 [phase: P1]
  ✅ P1.2: Stakeholder approvals (done) 🧊 [phase: P1] [executor: user]
  ...

▸ Phase P2: Migration — 8/8 done 🧊
  ✅ P2.1: Write goose migration 002 (done) 🧊 [phase: P2]
  ✅ P2.4: Update rollback playbook (done) 🧊 [phase: P2] ⚠️ divergence
     📝 [category:divergence] AC covered by adjacent P2.3 rollback script; standalone playbook was redundant.
  ✅ P2.5: Regenerate sqlc types (done) 🧊 [phase: P2] [executor: inline]
  ...

▸ Phase P3: Audit — 7/7 done 🧊 [executor: subagent-fresh]
  Phase AC (frozen):
    • AC: Two reviewers confirm no coverage regression.
  ✅ P3.1: Coverage audit (done) 🧊 [phase: P3] [executor: subagent-fresh] [parallel: audit-fresh]
  ✅ P3.2: Rollback audit (done) 🧊 [phase: P3] [executor: subagent-fresh] [parallel: audit-fresh]
  ...

spawns: 24/40 remaining · 0 active runs
```

## Meta

The recording is not literally captured from a shell session — it is a curated
walkthrough authored with the shipped tooling in mind. When v-next-2 lands, replaying
these commands against a fresh checkout should produce the same end state; any
divergence between this recording and reality is a regression signal.

Owner: pi-task-v-next Phase 6. Cross-referenced from
`docs/how-to/author-multi-phase-plan.md`.
