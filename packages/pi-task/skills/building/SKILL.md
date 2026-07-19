---
name: building
description: >
  Execute a plan built via the planning skill. Loop primitive for build mode: pick the next
  ready task, verify context, do the work, complete or annotate divergence, move to next.
  Use when a session runs out mid-plan, when picking up a paused plan, when implementing
  tasks from an active plan_tasks plan, or when handing off progress between sessions.
  Triggers on: "start building", "work through the plan", "implement the next task", "next
  task", "handoff", "resume", "continue the plan", plan_tasks start, plan_tasks complete,
  plan_tasks bulk-complete. Do NOT use for authoring a new plan — see the planning skill
  instead.
---

# Building: Executing a Verifiable Plan

Planning writes the contract. Building keeps it. This skill is the loop primitive: one
task at a time, one honest divergence when the plan is wrong, one machine-readable
handoff when a session runs out.

If you're authoring rather than executing, load `skills/planning/SKILL.md`.

## Core Loop

1. `plan_tasks status` — pick the highest-priority ready task.
2. Read the task's ACs, references, constraints, non-goals.
3. Load the referenced skills. Missing this step is the most common failure mode of build
   mode; see *When to `start`* below for the specific instance.
4. `plan_tasks start <id>` — this implicitly freezes the plan on first invocation.
5. Do the work — narrow to the task's ACs; do not smuggle scope.
6. Complete or annotate:
   - Reached the ACs? → `plan_tasks complete <id>` (with `divergence: "..."` if the task
     was never `in-progress`).
   - Reality diverged from plan? → `plan_tasks annotate <id> --category divergence` first,
     then `complete` — never silently swallow.
7. Repeat until `plan_tasks status` says `All tasks done!`.

## When to `start`

Before writing code, not after. The signal that you skipped this step: you're 200 lines
into an edit, notice a scope question, and check the ACs for the first time. That's
`start`-late.

**Why**: `start` freezes the plan on first invocation (see planning skill §Freezing).
If you write code first and `start` last, the code was written under a version of the
ACs that could still have been edited. The reviewer can't tell whether you wrote to the
frozen contract or wrote first and reverse-engineered the contract to match.

**Example**: session-3 of the wafer-poc doc-refactor plan opened with three tasks
`ready`. The main agent did 40 minutes of file edits, then belatedly called
`plan_tasks start` on all three at once. The AC-freeze fired on the first one; the
other two had been silently mutated during those 40 minutes. Reviewer had no way to
tell what the frozen contract looked like when the work happened.

**Fix pattern**: `plan_tasks start` is the second tool call in every task, right after
`plan_tasks get <id>` to see the ACs.

## When to `bulk-complete`

Only when the verification was bulk too. `bulk-complete` compresses N independent
complete-decisions into one call.

Legitimate uses:

- **Batch of trivially-symmetric tasks with a shared test that covers all N.**
  Example: five tasks each say "rename symbol X in file Y_i". A single `grep`
  confirms all five. One `bulk-complete` is honest — you verified them together.
- **Rollback of premature completions.** Not a common case, but if you `complete`d
  three tasks and a downstream reviewer says all three were wrong, you `unfreeze` and
  re-open them, then `bulk-complete` when re-fixed together.

**When NOT to bulk-complete:**

- **Different ACs, different verifications.** If task A's AC is a test and task B's AC
  is a doc paragraph, do NOT bulk them. Two calls, two separate honest decisions.
- **Any task in the batch was never `in-progress`.** `bulk-complete` on un-started
  tasks now requires a `divergence` string, and one string covers all un-started
  targets. That's rarely the truth — you have N different reasons for N different
  never-starts.

**Example**: session-2 of wafer-poc had a moment where 12 tasks looked "done from
the outside" after a big refactor sweep. The main agent used one `bulk-complete` with
divergence `"resolved by refactor sweep in commit abc123"`. Two of those 12 were
actually not resolved; the reviewer had to unbundle the completion and open two
regressions. Lesson: bulk-complete costs verifier work exactly proportional to the
number of items you compressed. Use it sparingly.

## Handling Plan Drift

Reality departs from plan. That's expected. The skill is to make it visible.

**Three drift shapes:**

1. **Scope drift** — the task's description matches reality but an AC does not.
   Example: the AC says "use `context.WithTimeout`" but the codebase's convention is
   `context.WithDeadline`. Reality is right; the AC is wrong. Do the correct thing,
   then `plan_tasks annotate <id> --category divergence "used WithDeadline per repo
   convention; AC was stale."` The reviewer sees the divergence when they audit.
2. **Design drift** — the task's design assumption is wrong. Example: the AC assumes
   a single-writer store; you discover concurrent readers exist and the design needs
   revision. STOP. Do NOT push through and paper over. `plan_tasks annotate <id>
   --category blocker` with the shape of the problem, THEN raise with the user or
   `phase-unfreeze` if this is your call to make.
3. **Scope creep** — the task's `files` list is short but you notice three adjacent
   improvements. RESIST. Those adjacent improvements are `add` calls, not silent
   expansions of the current task. If you must fix an adjacent thing to make the
   current task work, annotate the current task with `divergence` and record the
   forced adjacent edit.

**Never**: complete a task with `divergence: ""` or `divergence: "n/a"` — that's a
lie in the audit trail. Empty divergences are rejected by the primitive; nonsense
divergences aren't but should be. Write a real sentence or don't complete.

**Example**: mid-session-2 of wafer-poc, a task's AC said "add unit test for
`ParseBucket`". The implementer discovered `ParseBucket` had two callers with
subtly different semantics; unit-testing one broke the other. The right move was
`annotate --category blocker` and pivot to fixing the shared function first. What
actually happened was a rewrite of `ParseBucket` (out-of-scope), a rewrite of one
caller (out-of-scope), and a completion of the "add unit test" task. Session 3's
reviewer found the broken caller; the divergence had no annotation.

## The 37/40 handoff incident

In session 3 of the wafer-poc doc-refactor plan, the outgoing handoff document said
"subagent budget: ~37/40 remaining." No probe was called. The number was manufactured
from a mental estimate. Two sessions of downstream planning then anchored on 37/40 as
if it were a real number, including scheduling decisions ("we have room for three more
fresh-context audits before we hit the wall"). When someone finally checked the actual
budget, it was 12/40 remaining — nowhere near the invented figure. The handoff had
mis-informed 40 minutes of subsequent planning.

The remedy is not "estimate better." The remedy is **do not invent numbers**. When
`plan_tasks status` shows `spawns: probe-unavailable`, the handoff says
`spawns: probe-unavailable`. When you don't know, say you don't know. `~37/40` is a
lie masquerading as a rounding.

**When preparing an actual handoff, MANDATORY: read `references/handoff-template.md`
in full.** The template, tool-failure recovery, and loop-invariant rules live there —
this SKILL.md carries the case study; the reference carries the mechanics.

## Anti-Patterns

- **Reading skills after `start`**: the references section is meant to load BEFORE
  work begins. Reading a skill mid-task means you're already committed to the wrong
  frame. Remedy: `plan_tasks get <id>`, load every skill in `references.skills`, THEN
  `plan_tasks start`.
- **Completing without checking ACs**: "I did the thing" without re-reading the ACs
  to confirm the observable-behaviour check. Remedy: the last thing before `complete`
  is a re-read of the task's ACs; you name each one and how you verified it. If any
  AC is uncertain, `annotate --category divergence` before completing.
- **Silent scope creep**: touching files outside `task.files`. Remedy: if the edit is
  necessary, annotate with `divergence` naming the extra file and why. If it's not
  necessary, don't do it.
- **Fabricating budget/status numbers in handoffs**: see the 37/40 case study above.
  Never invent. Say "probe-unavailable" or "unknown" when that's the truth.

## Before shutting down a session, ask yourself

- Is `plan_tasks status` captured verbatim in the handoff, or did I summarise it?
- Does every task that changed status this session have either a clean `done` against
  its ACs, or an annotation naming why not?
- Is any task stuck in `in-progress` without a `divergence` or `blocker` annotation?
  (If yes, the invariant is broken. Fix or record.)
- Was the `spawns:` budget line copied verbatim, or did I type a number?
- Does the handoff preserve the next-ready task list so the next agent knows where to
  resume?

If any answer is "no" or "not sure," fix it before shutting down. The `references/handoff-template.md` covers the mechanics.
