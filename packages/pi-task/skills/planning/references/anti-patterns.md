# Planning anti-patterns — reference

**Load trigger:** MANDATORY before calling `plan_tasks create`, `plan_tasks add`, or
starting a fresh multi-session plan. Not needed for one-task fixes or spikes.

Nine anti-patterns from real pi-task usage. Each names symptom + remedy.

- **Plan without criteria**: "Implement feature X" with no definition of done → agent
  uses the description as its exit condition, so any output that vaguely matches
  satisfies its internal "am I done?" heuristic.

- **Criteria without verification method**: "App is responsive" → no reviewer can
  check this, so verification becomes a rubber stamp that always passes.

- **Missing references**: agent's first 3-5 tool calls become blind discovery
  (grep/find/read), producing lower-quality understanding than targeted reads because
  it doesn't know what it's looking for.

- **Scope creep via omission**: no non-goals → agent's helpfulness bias fills every
  adjacent gap it notices, multiplying the diff surface area for review.

- **Vague dependencies**: tasks with implicit ordering → parallel workers stomp each
  other's files or build on uncommitted assumptions.

- **`parallelGroup` without executor** (wafer-poc negative): you group four reviewer
  tasks under one `parallelGroup` but omit `executor: "subagent-fresh"`. The runtime
  then either spawns nothing (executor defaults to `any`) or runs them all inline in
  the parent context — destroying the independence that made the fanout worth doing.
  Symptom: reviewer verdicts look suspiciously similar; the "fresh" audits all cite
  the same three files. Remedy: any time `parallelGroup` names an audit/review
  fanout, set `executor: "subagent-fresh"` explicitly on the tasks or on their
  phase's `defaults.executor`.

- **Description-as-AC**: task description reads "Add the retry loop with backoff" and
  the AC section is empty or restates the description. Symptom: reviewer accepts
  because the description says the loop exists, without checking behaviour. Remedy:
  ACs must be observable-behaviour statements the reviewer can verify against the
  diff. If the AC and description are paraphrases, delete the AC — it's dead weight
  — and rewrite as reviewer-observable behaviour.

- **Two sources of truth** (wafer-poc negative): the plan lives in a `PLAN.md` file
  AND in `plan_tasks` state, and the two drift. By session 3 of the wafer-poc
  doc-refactor plan, PLAN.md said 40 tasks and `plan_tasks status` said 73 — the file
  lagged three batches of `plan_tasks add`. Symptom: reviewer reads PLAN.md and audits
  against a version of reality no agent uses; agent trusts `plan_tasks` and drifts
  from user's mental model. Remedy: pick one — either `plan_tasks` is the source of
  truth and PLAN.md is auto-regenerated (via `plan_tasks status` piped to a file), or
  PLAN.md is authoritative and `plan_tasks` runs on parsed markdown. Never both.

- **Unfreezing to escape implementation pain**: first move on a frozen task is "I
  need to unfreeze the ACs" because the code is hard. Symptom: unfreeze events cluster
  around tasks the executor is struggling with, not around genuine requirement changes.
  Remedy: `unfreeze` only for requirement change (user or product owner changed what
  done means) or scope pivot (mid-plan design revision). If your instinct is
  "implementation is harder than expected," the implementation is off, not the
  criteria.
