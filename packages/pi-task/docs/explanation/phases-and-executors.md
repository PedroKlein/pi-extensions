# Phases and executors — an explanation

This document explains the mental model behind pi-task's phase, executor, and defaults
system. It does not tell you which action to call — see the
[reference](../reference/plan-tasks-actions.md) or the
[how-to guide](../how-to/author-multi-phase-plan.md) for that.

## Phases

A phase is a first-class group of tasks with its own acceptance criteria, executor default,
freeze bit, and DAG position. Where tasks answer "what is this piece of work?", phases
answer "what does this stage of the project verify?"

Every plan has at least the implicit `_root` phase. Tasks with no `phaseId` belong to it.
Legacy plans (no phases declared) look identical from the outside — the `_root` phase
materialises at read time and never persists to disk. Adding phases is additive.

### When to use phases

Any plan crossing sessions, any plan with more than about ten tasks, any plan where
distinct "kinds of work" (design vs. implementation vs. audit) run in sequence. The
signal is: your reviewer needs to sign off on chunks, not on the whole plan at once.

### When NOT to use phases

Single-session bug fixes, spikes, tight refactors of one file. The `_root` phase covers
those without ceremony. Adding phases just to organise a five-task plan is over-engineering.

## Executor

Every task ends up running somewhere. The `executor` field says where. Five values:

- **`any`** — no preference. Runtime picks. This is the default and the right choice for
  most tasks.
- **`inline`** — the current agent runs the task in its own context, no spawn. Use for
  orchestration, small edits, and any work where you want the parent's history and
  ongoing state.
- **`subagent-fresh`** — spawn a fresh-context subagent with no parent history. Use for
  independent review, audits, oracle calls, blind verification. The independence is the
  point.
- **`subagent-fork`** — spawn a forked-context subagent that inherits the parent's context.
  Use for long-running side work that benefits from the parent's discovery so far.
- **`user`** — a human executes. Agent hands off. Use for approvals, commits, external
  decisions.

### Calibration examples

- **Example — reviewer fanout → `subagent-fresh`.** Four independent skill audits, each
  in its own fresh context. `parallelGroup: audit-fresh` + `executor: subagent-fresh`
  gives the runtime permission to fan out and the independence guarantee that makes
  the audit valuable.
- **Example — plan authoring → `inline`.** The plan itself is written and maintained by
  one agent holding the whole picture. Delegating plan authorship to a subagent produces
  incoherence.
- **Example — commit / merge → `user`.** The final push, merge, or squash step is a
  human decision. Even after every AC is met.
- **Example — most work → `any`.** Individual "run this test", "update this file" tasks
  don't care. Let the runtime decide.
- **Example — long-running exploration → `subagent-fork`.** When the parent has spent
  40 minutes exploring the codebase and the follow-up task benefits from that history,
  `subagent-fork` shares the context. Rare.

## Defaults cascade

Both `plan.defaults` and `phase.defaults` exist. When a task field is unset, the runtime
looks up: **task → phase → plan → hard default**. Two kinds of resolution:

- **Scalars** (`executor`, `parallelGroup`): first non-empty value wins. Task overrides
  phase overrides plan.
- **Arrays** (`referenceSkills`, `constraints`, `nonGoals`, `acceptanceCriteria`): concat
  in task → phase → plan order, then dedupe by string equality. Task entries land first
  so the reviewer sees the task's most specific claims before the phase's or plan's
  wider ones.

### When defaults help

Cross-cutting invariants and repeated skill loads. If every task in a phase should load
`go-testing` and `go-dev`, set `phase.defaults.referenceSkills` once instead of typing
those two names on every task. The reviewer sees them on every task via `get --verbose`
without you having to maintain the redundancy.

### When defaults obscure

If a task's constraints all come from `plan.defaults` and the task's own `constraints`
array is empty, a quick read of the task feels underconstrained. Defaults help writers;
they can hide the truth from readers. Prefer explicit task-level entries when the
constraint is task-specific.

## Divergence and drift

Real plans drift from the plan document. That is expected. The skill is to make the
drift visible.

Every annotation has an optional `category`. Setting it to `divergence` earns a ⚠️ badge
in `plan_tasks status` output and in the widget. The category exists so a reviewer
scanning the plan can find every point where reality departed from intent without
reading every annotation.

### The 37/40 case study

Session three of the wafer-poc doc-refactor plan is the canonical negative example. The
outgoing handoff document included a line "subagent budget: ~37/40 remaining." No probe
had been called. The number was manufactured from a mental estimate. Two subsequent
sessions of planning anchored on 37/40 as a real figure, including scheduling decisions
("we have room for three more fresh-context audits"). When someone finally called
`getSpawnBudget()`, the actual remaining was 12/40. The invented number had
mis-informed forty minutes of downstream planning.

What went wrong: the fake precision passed as truth because the drift wasn't recorded
anywhere. There was no divergence annotation on the handoff, no "the number is a guess"
qualifier. The scratchDir mid-plan oracle would have caught it if it existed.

What the primitives now provide: `plan_tasks status` prints
`spawns: probe-unavailable` when the bridge can't confirm the number, so the fake
precision has no way to enter the system. The `never invent numbers` rule in the
building skill is the second line of defence.

## When to verify

`plan_tasks verify` and `plan_tasks phase-verify` are **opt-in**. They never fire
implicitly. Nothing about `plan_tasks complete` on the last task of a phase forces a
verify pass. Nothing about `phase-freeze` forces one. If your plan is small, you can
skip verify entirely — the tool will not stop you.

### When to skip

- The plan has fewer than ~5 tasks.
- All tasks are in `_root` (no phase structure).
- Nothing was delegated (no `subagent-fresh` or `subagent-fork` executors).
- You accept that the independent-panel signal will not be collected.

### When to invoke

- Multi-phase plans crossing sessions.
- Plans with delegated fresh-context work that a single reviewer wouldn't catch.
- Any plan where the block-on-FAIL contract matters (verify blocks `complete` on the
  last task of a phase when the most recent report is not PASS).

Verify runs a fixed panel of four reviewer roles by default: completeness, correctness,
safety, quality. Custom roles are a v-next non-goal. When the pi-subagents bridge is
unavailable, verify returns `{ unavailable: true, reason, verdict: "unknown" }` and
writes no report — it does not fabricate a verdict.

For the exact report shape and override protocol, see the
[design doc](../design/verify.md) and the
[reference](../reference/plan-tasks-actions.md#actions--verification-opt-in).
