# Multi-session refactor — worked example plan

This is the reference model the `planning` skill teaches. It shows a ~20-task plan across
three phases, using every pi-task primitive that a real multi-session refactor needs:
first-class phases, executor cascade, `parallelGroup`, `{scratchDir}`, and divergence
annotations. Copy the shape when starting your own multi-session plan.

**Setting:** hypothetical refactor of a service's persistence layer. Three phases:

1. **P1 Design** — write ADRs, freeze the schema.
2. **P2 Migration** — write goose migrations, add sqlc queries, backfill.
3. **P3 Audit** — independent review of the migration.

## Plan skeleton

```jsonc
{
  "name": "persistence-layer-refactor",
  "scratchDir": "/Users/dev/.pi/plans/persistence-layer-refactor/scratch",
  "defaults": {
    "executor": "any",
    "referenceSkills": ["go-dev", "go-safety"]
  },
  "phases": [
    {
      "id": "P1",
      "title": "Design",
      "description": "ADRs and schema freeze",
      "order": 1,
      "dependsOn": [],
      "acceptanceCriteria": [
        "AC: ADR-014 (persistence) merged. Verify: docs/adr/014-*.md exists on main.",
        "AC: Schema DDL frozen in migrations/schema-v2.sql. Verify: file exists + reviewer sign-off."
      ],
      "defaults": {
        "executor": "inline"
      }
    },
    {
      "id": "P2",
      "title": "Migration",
      "description": "Write goose migrations + sqlc queries",
      "order": 2,
      "dependsOn": ["P1"],
      "defaults": {
        "referenceSkills": ["go-sqlc", "go-wiring"]
      }
    },
    {
      "id": "P3",
      "title": "Audit",
      "description": "Independent review of the migration",
      "order": 3,
      "dependsOn": ["P2"],
      "acceptanceCriteria": [
        "AC: Two independent reviewers confirm no test coverage regression. Verify: audit report at {scratchDir}/audit/coverage.md.",
        "AC: Rollback path verified against a copy of production dump. Verify: audit report at {scratchDir}/audit/rollback.md."
      ],
      "defaults": {
        "executor": "subagent-fresh"
      }
    }
  ]
}
```

## Phase 1: Design (P1.x, inline)

Every task inherits `executor: "inline"` from the phase defaults — one agent owns the writing.

| Task | Title | Depends | parallelGroup | Executor override | Notes |
|------|-------|---------|---------------|-------------------|-------|
| P1.1 | Draft ADR-014 skeleton | — | — | — | inherits inline |
| P1.2 | Interview stakeholders on retention windows | P1.1 | — | `user` | approvals need human |
| P1.3 | Fill ADR-014 with stakeholder decisions | P1.2 | — | — | inherits inline |
| P1.4 | Draft schema-v2 DDL | P1.3 | — | — | inherits inline |
| P1.5 | Freeze schema-v2 DDL, merge ADR-014 | P1.4 | — | `user` | commit is a human step |

**Phase 1 ACs** (frozen after P1.5):

- AC: docs/adr/014-persistence.md exists on main. Verify: git log --diff-filter=A shows the file.
- AC: migrations/schema-v2.sql exists and matches ADR-014 §3. Verify: reviewer signs the ADR.

## Phase 2: Migration (P2.x, mixed)

Executor defaults to `any` at the phase level (inherits from plan), but individual tasks
override where the workload is delegatable.

| Task | Title | Depends | parallelGroup | Executor | Notes |
|------|-------|---------|---------------|----------|-------|
| P2.1 | Write goose migration 002-add-events-table | P1.5 | | any | |
| P2.2 | Write sqlc queries: events.sql | P2.1 | | any | |
| P2.3 | Write sqlc queries: outbox.sql | P2.1 | queries-parallel | any | same phase as P2.2 |
| P2.4 | Write sqlc queries: idempotency.sql | P2.1 | queries-parallel | any | ditto |
| P2.5 | Regenerate sqlc types (single-writer) | P2.2, P2.3, P2.4 | | inline | one agent, no fanout |
| P2.6 | Backfill script for existing rows | P2.5 | | any | |
| P2.7 | Backfill dry-run against snapshot | P2.6 | | inline | writes to `{scratchDir}/backfill/dryrun.log` |
| P2.8 | Phase 2 gate: tsc + tests + coverage | P2.7 | | any | |

**Note the `parallelGroup: queries-parallel` on P2.3+P2.4** — those sqlc files don't overlap,
so the runtime can run both concurrently. P2.5 (regeneration) is deliberately NOT in the
group because it's a single-writer step over generated code.

**{scratchDir} usage** — P2.7's dry-run writes to `{scratchDir}/backfill/dryrun.log`. That
same log is a `references.files` entry on P2.8's gate task, so the reviewer can attest
without re-running the backfill.

## Phase 3: Audit (P3.x, subagent-fresh fanout)

Executor defaults to `subagent-fresh` at the phase level — every audit runs in its own
context. This is the wafer-poc reviewer-fanout pattern.

| Task | Title | Depends | parallelGroup | Executor | Notes |
|------|-------|---------|---------------|----------|-------|
| P3.1 | Coverage audit (subagent-fresh) | P2.8 | audit-fresh | subagent-fresh | writes {scratchDir}/audit/coverage.md |
| P3.2 | Rollback audit (subagent-fresh) | P2.8 | audit-fresh | subagent-fresh | writes {scratchDir}/audit/rollback.md |
| P3.3 | Perf audit (subagent-fresh) | P2.8 | audit-fresh | subagent-fresh | writes {scratchDir}/audit/perf.md |
| P3.4 | Security audit (subagent-fresh) | P2.8 | audit-fresh | subagent-fresh | writes {scratchDir}/audit/security.md |
| P3.5 | Synthesise audit findings | P3.1, P3.2, P3.3, P3.4 | | inline | reads all four reports |
| P3.6 | Address blocking findings | P3.5 | | any | may loop back into P2 |
| P3.7 | Final phase-verify (opt-in) | P3.6 | | | `plan_tasks phase-verify P3` |

**Guardrails made explicit:**

- Four `subagent-fresh` tasks in one `parallelGroup` = four spawn budget slots. With a session
  cap of 40 that's fine, but you should have counted before landing on four. Plans that would
  spawn 20+ fresh-context reviewers in one phase are one budget-tightening away from a wall.
- Every audit writes to a distinct file under `{scratchDir}/audit/`. Zero file overlap = safe
  to fanout.
- P3.5 (synthesis) is `inline` because one agent needs to hold all four reports at once.

## Divergence annotations

A real plan collects them. Example annotations that would land during execution:

- On P2.6: `plan_tasks annotate P2.6 --category divergence "Backfill script needed a batch
  size env var to fit within the transaction budget; added BATCH_SIZE=5000 as configurable."`
- On P3.3: `plan_tasks annotate P3.3 --category blocker "Perf audit found 2× slowdown on
  the outbox flush hot path; pushed hotfix task P2.9 into the plan and re-ran the audit."`
- On P3.5: `plan_tasks annotate P3.5 --category decision "Synthesis judgement call: accept
  the 5% latency regression given the correctness win; documented in ADR-014 amendment."`

Every annotation with `category: "divergence"` earns a ⚠️ badge on the task in `plan_tasks
status` output, so the reviewer's eye is drawn to where reality departed from plan.

## What this example demonstrates

- **Phases with their own ACs**: P1 and P3 have phase-level ACs; P2 doesn't (its work is
  fully attributed to tasks). Both patterns are legal.
- **Executor cascade**: `subagent-fresh` in P3 defaults; `inline` in P1 defaults; task-level
  overrides on P1.2 and P1.5 (`user`). Every task's resolved executor is predictable from
  the cascade alone — no surprises at run time.
- **`parallelGroup` as a concurrency tag, not an executor signal**: P2.3+P2.4 share
  `queries-parallel` and default to `any`; P3.1-P3.4 share `audit-fresh` and use
  `subagent-fresh`. The group tells the runtime "safe to fanout"; the executor tells it
  "here's the flavour".
- **`{scratchDir}` as the shared drafting surface**: dry-run logs, audit reports, and
  synthesis outputs all live under it and are cross-referenced from later tasks.
- **Divergence annotations**: reality-vs-plan drift is captured explicitly, not silently
  papered over.

## Non-goals of this example

- Not a template you copy verbatim — the phases and tasks are illustrative.
- Not a claim that every plan needs three phases. Plans with fewer than 10 tasks skip phases entirely.
- Not a demonstration of `plan_tasks verify` — that's opt-in and worth a separate example
  when the primitive matures. See `docs/design/verify.md`.
