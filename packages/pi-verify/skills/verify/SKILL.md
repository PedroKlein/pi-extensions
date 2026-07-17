---
name: verify
description: >
  Usage methodology for the pi-verify verification system. When and how to use /freeze
  and /verify effectively. Covers acceptance criteria format, reviewer mechanics,
  interpreting verdicts, and integration patterns. Triggers on: /freeze, /verify,
  "verify this", "check if done", "are we done", "review the work", "verification",
  "independent review", "blind review". Do NOT use during implementation (use
  proof-of-work) or during planning (use planning skill).
---

# Verify: Independent Work Verification

The verification system separates the doer from the checker. The implementing agent
cannot grade its own work — a structural limitation, not a bug.

Tools: `freeze_criteria` (lock contract) → `verify_work` (spawn blind reviewers).
Commands: `/freeze` (interactive) → `/verify` (interactive).

## NEVER

- **NEVER verify without frozen criteria** — reviewers without an immutable contract produce vague "looks good" verdicts that prove nothing
- **NEVER re-freeze to weaken criteria after a FAIL** — fix the work, not the contract. Unfreezing to water down criteria defeats the entire system.
- **NEVER verify individual subtasks** — verify at the feature/plan level. Subtask verification burns 4x reviewer cost for granularity that doesn't matter.
- **NEVER ignore reviewer contradictions** — if Completeness PASS + Correctness FAIL, there's a gap between "addressed" and "works". Investigate.
- **NEVER run verification in a loop without fixing** — re-verifying the same unchanged code hoping for a different result is cargo culting.

## When to Freeze

Freeze criteria **after planning, before building**:
- Plan is finalized and reviewed
- Acceptance criteria are specific and testable
- You've answered "how will a blind reviewer verify this?"

Do NOT freeze:
- During exploration/prototyping
- When criteria are still vague (refine first)
- If requirements may change during implementation

## When to Verify

Trigger verification:
- After completing all tasks in a plan
- At meaningful breakpoints (end of a feature, before PR)
- When the orchestrator (you, babysitter) reaches a "checkpoint" step
- Before declaring work "done" for tasks with frozen criteria

**Pre-check**: Confirm criteria are frozen before running /verify. If not frozen, freeze first — verdicts against unfrozen criteria are unreliable opinions, not pass/fail gates.

## The 4 Reviewers

| Reviewer | What they check | Model |
|----------|----------------|-------|
| **Completeness** | Every AC addressed, no missed items | Opus (thorough) |
| **Correctness** | Tests meaningful, actually pass, exercise the change | Sonnet (can run tests) |
| **Quality** | Code practices, patterns, codebase fit | GPT (cross-provider perspective) |
| **Safety** | Blast radius, regressions, side effects | Opus (conservative) |

Each reviewer:
- Gets **fresh context** (never saw the implementation session)
- Receives ONLY: frozen criteria + git diff + repo access
- Cannot modify code (read-only)
- Produces a structured verdict

## Good Acceptance Criteria

Criteria follow the `AC: [behavior]. Verify: [method].` format (see planning skill for full methodology). Quick examples:

```
AC: Frozen tasks reject criterion updates with clear error message.
Verify: Call updateTask on frozen task, assert it throws with "frozen" in message.

AC: /verify spawns all 4 reviewers and reports their status.
Verify: Mock RPC bus, trigger verify_work, confirm 4 spawn calls with distinct agent names.
```

**Negation blindness**: LLMs systematically underweight negation. Criteria framed as "must NOT do X" are the weakest enforcement point. Phrase criteria as positive assertions whenever possible:
- Bad: "Must NOT load all records into memory"
- Good: "AC: Query uses database-level filtering. Verify: EXPLAIN shows index scan, not seq scan."

When a prohibition is unavoidable, pair it with a positive check the reviewer can verify.

## Why Adversarial Framing Works

Asking a model "is this correct?" produces confirmation. Asking it "find where this breaks" produces investigation. Our reviewers work because they're framed as skeptics who reject by default:
- Completeness: "Find missing items" (not "confirm everything is addressed")
- Correctness: "Find tests that would pass even without the implementation"
- Safety: "Find what could break downstream"

This framing matters when writing custom reviewer prompts. The instruction "assume it's broken until proven safe" produces fundamentally different behavior than "check if it works."

## Failure Recovery

When verification returns non-PASS verdicts, follow this decision tree:

| Verdict pattern | Diagnosis | Action |
|----------------|-----------|--------|
| All PASS | Work is done | Ship it |
| Completeness FAIL, others PASS | Missed an AC entirely | Implement the missing criterion, re-verify |
| Correctness FAIL, others PASS | Tests broken or insufficient | Fix tests to exercise the actual change |
| Quality FAIL, others PASS | Works but poorly written | Refactor without changing behavior, re-verify |
| Safety FAIL | Blast radius / regression risk | Add safety nets (rollback, feature flag), re-verify |
| Multiple FAIL | Fundamental gap | Re-read the criteria cold, identify root cause before fixing |
| Contradictions (PASS + FAIL on same AC) | Ambiguous criterion | DON'T unfreeze — investigate which reviewer is wrong |

**The re-verification loop:**
1. Fix only what the FAIL verdict identified
2. Run proof-of-work discipline for the fix (evidence!)
3. Re-verify. If PASS → done. If same FAIL → misdiagnosed the issue.

**When to escalate to human**: After 2 failed re-verifications on the same criterion, or when reviewers contradict each other.

## Aggregating Results

After reviewers complete:
1. Read each reviewer's verdict output (via `subagent({ action: "status" })` or fleet view)
2. Map verdicts to the failure recovery table above
3. Present a unified summary to the user: per-reviewer status, overall verdict, recommended action
4. If all PASS → report done. Otherwise → fix and re-verify.

**A good FAIL verdict has a repro, not an opinion.** "This looks risky" is useless to the implementing agent. "Input: empty array on line 12 throws TypeError" is a test case. When reviewing verdicts, prioritize FAILs that include concrete failing inputs or specific file:line references. Vague FAILs ("might have issues") need investigation before acting on them.

## Integration Patterns

### As a plan step
```
task: "Verify all tasks"
dependsOn: ["all-implementation-tasks"]
acceptanceCriteria: ["All 4 reviewers return PASS"]
```

### In orchestrator workflows
Babysitter or chain: plan → implement → verify → fix → re-verify

### Manual
Type `/verify` when ready to check. Use `/freeze` first if criteria aren't locked.

## Verification Without Frozen Criteria

If criteria aren't frozen, verification still runs but with weaker guarantees:
- Reviewers infer "done" from plan description (subjective)
- No immutable contract — verdicts are opinions, not pass/fail
- Useful for exploratory quality checks, not for gatekeeping

Always prefer frozen criteria for meaningful verification.

## Cost Considerations

4 reviewers × different models = non-trivial cost. Use verification:
- ✅ For important features with frozen criteria
- ✅ Before PRs on complex changes
- ✅ At milestone boundaries
- ❌ Not for every minor subtask
- ❌ Not for trivial config changes
- ❌ Not when you're just exploring
