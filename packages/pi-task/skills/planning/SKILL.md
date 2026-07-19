---
name: planning
description: >
  DoD-aware planning methodology that produces self-contained, verifiable task plans.
  Every task gets acceptance criteria a blind reviewer can verify, references for context,
  constraints, non-goals, danger zones, and an executor. Plans use first-class phases
  when the work spans more than ~10 tasks. Use when creating or updating plans via
  plan_tasks, Plannotator, babysitter, or plain markdown. Triggers on: plan creation,
  task planning, "plan this", "create tasks", "break this down", acceptance criteria,
  Definition of Done, DoD, "what does done mean", phases, executor. Do NOT use for
  executing/implementing tasks — this skill is for planning phase only.
---

# Planning: Self-Contained, Verifiable Task Plans

Plans exist so any agent can pick up a task cold and execute it without discovery overhead.

**If you're implementing rather than planning, see `skills/building/SKILL.md` for the
execution loop primitive.**

## Core Rule

Every task MUST answer four questions an independent reviewer can verify:
1. **What is done?** — Acceptance criteria (observable, testable conditions)
2. **Where is context?** — References (skills, files, docs, repos, memory)
3. **What is NOT done?** — Non-goals and constraints (explicit boundaries)
4. **Who runs it?** — Executor (`any` | `inline` | `subagent-fresh` | `subagent-fork` | `user`)

## Acceptance Criteria Format

Write criteria that a third party can verify without seeing the implementation session.

**Good criteria** are atomic, observable, and testable:

```
AC: User with locale=de sees all nav labels in German after saving preference.
Verify: Browser check against German-locale test user shows translated labels.

AC: Pagination returns correct total count for filtered queries.
Verify: Test asserts response.total matches DB count with same filter applied.

AC: /verify command spawns 4 reviewers and collects verdicts.
Verify: Integration test mocks RPC bus, confirms 4 spawn calls with correct params.
```

**Sharpening vague criteria**: when a criterion feels soft, apply these transforms:

- Replace adjectives with measurements: "fast" → "<100ms p99"
- Replace "properly" with the observable behavior: "properly handles" → "returns 400 with {error: ...}"
- Add the `Verify:` line — if you can't write it, the criterion is untestable
- Ask: "Could two reviewers disagree about whether this passes?" If yes, sharpen it.

Worked example — vague → sharp:

```
❌ AC: App is responsive.
✅ AC: Home page LCP ≤ 2.0s on 3G Fast throttling. Verify: Lighthouse CI budget check.
```

**Conversion technique**: ask "How would a reviewer who never saw the code PROVE this is done?"
If the answer requires reading the implementation reasoning, the criterion is too vague.

## Planning Granularity

Match depth to risk. Don't over-plan spikes. Don't under-plan features.

| Work type | Tasks | Phases | ACs per task | References needed? |
|-----------|-------|--------|--------------|--------------------|
| Spike / exploration | 1 | none (`_root`) | 0-1 ("learned X") | Minimal |
| Bug fix | 1-2 | none (`_root`) | 2-3 ("reproducer + fix + no regression") | File + test path |
| Single feature | 2-5 | none or one | 2-4 each | Skills + files + related |
| Multi-session epic | 5-15 | 2-4 phases | 3-5 each | Full references + ADR |
| Cross-package refactor | 15-50 | 4-8 phases | phase-level + task-level ACs | Phase-level executor cascade |

**Decision rule**: if a single task has >5 ACs, split it. If a plan has >10 tasks, group
into first-class phases (`plan_tasks phase-create`). Phases get their own AC set, executor
default, and freeze bit — a phase-level guard means the reviewer can attest to a coherent
slice of work.

## Phases

Phases are first-class. A phase is a group of tasks with:

- **Its own acceptance criteria** — e.g., "Phase 3 complete: bridge module isolated, executor
  enforcement live on start". Verifiable by `plan_tasks phase-verify` or by an independent reviewer.
- **Its own executor default** — e.g., a "reviewer" phase defaults every task to
  `subagent-fresh`; an "orchestration" phase defaults to `inline`.
- **Its own freeze bit** — freezing a phase locks its ACs; you can freeze phases in stages
  as they solidify.
- **Its own DAG position** — phases can depend on other phases (`dependsOn`). Task dependencies
  still cross phases; phases just carry the structure the reviewer reads first.

**When to add phases**: any plan crossing sessions, any plan with more than ~10 tasks, any plan
with distinct "kinds of work" (design vs. implementation vs. audit).

**When NOT to add phases**: single-session bug fixes, spikes, tight refactors of one file.
The implicit `_root` phase covers those without ceremony.

## References

Every task should include what the implementing agent needs to load BEFORE writing code:

| Field | When to include | Example |
|-------|-----------------|---------|
| `skills` | When domain-specific methodology applies | `["go-dev", "go-testing", "coding-discipline"]` |
| `files` | Key source files, configs, ADRs to read first | `["internal/auth/handler.go", "docs/adr/003-auth.md"]` |
| `repos` | External repos with relevant patterns | `["github.com/some/library"]` |
| `docs` | External documentation, specs, RFCs | `["https://pkg.go.dev/context"]` |
| `memory` | Memory keys with relevant project decisions | `["project.auth.design", "pref.testing.order"]` |

**Rule**: if you find yourself thinking "the agent will need to discover X", put X in references.

The `{scratchDir}` template variable expands to the plan's scratch directory at read time —
use it for shared drafts, escalation queues, or oracle reports the plan writes to itself.
See `examples/multi-session-refactor.md` for how `{scratchDir}` gets used as a shared
drafting surface across phases.

## Choosing an Executor

Every task ends up running somewhere. The `executor` field says where. Values cascade
**task > phase > plan.defaults > `any`**.

| Value | Meaning | Use when |
|-------|---------|----------|
| `any` | No preference — runtime decides. Default. | Most tasks. You're not opinionated. |
| `inline` | Current agent runs it, no spawn. | Orchestration, coordination, small edits. |
| `subagent-fresh` | Spawn a fresh-context subagent (no parent history). | Independent review, audits, oracle calls, blind verification. |
| `subagent-fork` | Spawn a forked-context subagent (shares parent context). | Long-running side-work that benefits from parent's discovery. |
| `user` | Human executes; agent hands off. | Approvals, commits, external decisions, anything the agent must not do alone. |

**Calibration examples** — drawn from the wafer-poc doc-refactor plan (73 tasks, 3 sessions):

- **Example: reviewer/audit fanouts → `subagent-fresh`.** The wafer-poc plan's four independent
  skill audits (wafer-project, dag-orchestration, async-tokio, rust-async-orchestration) each
  ran as a fresh-context subagent. They needed no shared history and their independence was the
  point. Same pattern: any `parallelGroup` where the workers should NOT influence each other.
- **Example: writer/planner → `inline`.** The plan's own composition and revision was `inline`
  — one agent maintaining coherence across the whole plan. Never delegate the plan itself.
- **Example: user-approval steps → `user`.** The final commit / squash-and-merge on
  wafer-poc's doc-refactor branch was a `user` step. Not the review — the pushing.
- **Example: most tasks → `any`.** ~60 of the 73 wafer-poc tasks were "run this test",
  "update this file". They didn't care about executor; the runtime picked.

**Guardrails on `subagent-fresh`/`subagent-fork`:** the runtime enforces a per-session spawn
budget (default 40, configurable via `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`). When budget is
exhausted, `plan_tasks start` on a subagent-executor task blocks with
`{blocked: true, reason: "subagent-budget-exhausted"}` and returns escalation options. Design
your plan so the total subagent-executor task count is comfortably under budget.

## Constraints and Non-Goals

Constraints prevent scope creep and protect invariants:

- "Must not change the public API signature"
- "Must work with existing auth middleware — no new dependencies"
- "Performance must not regress: <100ms p99 latency"

Non-goals make boundaries explicit:

- "Not implementing the admin UI — only the API endpoint"
- "Not optimizing for concurrent access yet — single-writer is fine"
- "Not migrating existing data — only new records use the new schema"

## Sub-Tasks

Sub-tasks are the fine-grained decomposition inside a single task. Three valid patterns:

1. **per-file**: one sub-task per file edit within a coordinated change. Use when the parent
   task's `files` list is long and the edits are similar. Sub-tasks let the reviewer scan the
   diff file-by-file.
2. **per-target**: one sub-task per platform, environment, or artefact. Use when the
   implementation is repeated across different targets.
3. **TDD cycle**: one test + one implementation cycle per sub-task. The classic pattern; it is
   not the only valid pattern.

**When NOT to use sub-tasks**: if the "sub-tasks" don't share the same references, files, or
executor, they should be sibling tasks — possibly grouped by `parallelGroup` if they can run
concurrently. Sub-tasks share the parent task's context; sibling tasks each declare their own.

## Freezing Criteria

The plan freezes **implicitly on first `start`**. When you call `plan_tasks start T1` on a
plan that has never been frozen, pi-task sets `plan.frozen = true`, locks every task's ACs,
and logs a one-line notice.

**Planner responsibility before first `start`:**

1. Present the plan's ACs to the user via `ask_user` for structured confirmation.
2. Address any last edits from user feedback.
3. Only then call `start` — knowing that the freeze fires the moment you do.

**How to unfreeze legitimately** — two triggers only:

- **Requirement change**: the user or product owner explicitly changes what "done" means.
  Unfreeze the affected task, edit, refreeze via `phase-freeze` or by starting another task.
- **Scope pivot**: mid-plan, you discover the design is wrong. Not that a specific edit is
  hard, but that the overall shape has to change. Unfreeze, revise, ideally rewrite the
  plan from scratch.

**Worked cycle** — requirement change:

```
plan_tasks unfreeze --taskId T3
plan_tasks update --taskId T3 --updates '{"acceptanceCriteria":["AC: new criterion"]}'
plan_tasks phase-freeze --phaseId P2   # or `plan_tasks start` on the next task
```

**How NOT to unfreeze**: implementation is harder than expected. If your first move on a
frozen task is "I need to unfreeze the ACs", stop and ask whether the implementation is off,
not the criteria. This anti-pattern is in `references/anti-patterns.md`.

**Attempting to modify frozen ACs**: `plan_tasks update` and `plan_tasks add-criteria` on a
frozen task return `Error: Task X is frozen`. The `add-criteria` action is deprecated in
favour of `update` with `updates.acceptanceCriteria`.

## Final Sanity Check

Before calling `plan_tasks create`, verify:

**Hard invariants (MUST):**

- [ ] `dependsOn` forms a valid DAG (no circular deps).
- [ ] `parallelGroup` tasks have zero file overlap (equivalently: tasks with overlapping files never share a `parallelGroup`).
- [ ] Every AC has a `Verify:` method a blind reviewer can execute.

**Taste calls (SHOULD):**

- [ ] No task has >5 ACs. If it does, split.
- [ ] Non-trivial tasks have at least one non-goal.
- [ ] Each task's `executor` is either explicit or resolves via cascade to something sensible.
- [ ] Every phase that will span sessions has phase-level acceptance criteria.

**Pre-flight:** MANDATORY read of `references/anti-patterns.md` before you call `plan_tasks create`. Nine patterns, real wafer-poc negatives, checkable against your plan.

## Reference example

See `examples/multi-session-refactor.md` for a fully worked ~20-task, 3-phase plan
demonstrating phases, executor cascade, `parallelGroup`, `{scratchDir}`, and divergence
annotations.

**Do NOT load `examples/multi-session-refactor.md` for spikes, single-task bug fixes, or
plans with fewer than ~5 tasks.** The example's scale will mislead your granularity.
