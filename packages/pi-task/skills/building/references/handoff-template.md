# Handoff template — reference

**Load trigger:** MANDATORY when preparing a handoff at session end. Not needed
otherwise.

## Contract

The handoff is a **fact record**, not a summary. The next agent needs raw facts, not
your reading of them.

## Required fields

- `plan_tasks status` output, verbatim. Not summarised.
- The last few tool calls' truncated results (what was tried, what happened).
- Any open divergence annotations (`plan_tasks status` surfaces these with a ⚠️ badge).
- If pi-subagents is loaded: the live spawn budget line from `plan_tasks status`
  — verbatim, never re-typed. Currently rendered as `spawns: N/M remaining · K
  active runs` OR `spawns: probe-unavailable`.

**Never invent numbers.** This is the single most important rule of handoff writing.
The 37/40 case study in the main SKILL.md is the negative example.

## Template (copy verbatim, fill in the blanks)

```
## Handoff — <plan-name> — <session-N>

### Plan status
<paste `plan_tasks status` output verbatim>

### Last tool calls
1. <tool>(<args>) → <result-first-line>
2. <tool>(<args>) → <result-first-line>
3. ...

### Open divergences
- <task-id>: <divergence-annotation-text>

### Budget line
<paste the `spawns:` line from status verbatim>

### Blockers / open questions
- <blocker-1>
- <blocker-2>
```

Do not summarise. Do not invent. Do not paraphrase the tool output.

## Tool-failure recovery

If `plan_tasks status` errors or returns a stale plan, do NOT proceed to `start` —
first record the failure in the handoff as a blocker with the exact error string, then
raise. A silent-error handoff misinforms the next agent more than an incomplete one.

If `start` is refused because the plan is already frozen and you weren't the freezer,
record the freeze state and the freezer identity in the handoff's Blockers section. Do
not `unfreeze` speculatively.

## Loop invariant

At any point during a plan's execution, exactly one task is `in-progress`, OR the plan
is between tasks (all previously-in-progress tasks are `done`/`skipped` and no new
`start` has fired). Violations of this invariant are always a bug in the executor's
loop, never in the plan.

Check this invariant in the handoff. If more than one task is `in-progress` or a task
is `in-progress` without a corresponding action in the last-tool-calls list, name it
as a blocker.
