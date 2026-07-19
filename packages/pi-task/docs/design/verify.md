# Verify primitive — design

Design spec for `plan_tasks verify` and `plan_tasks phase-verify`. Ties into pi-subagents via the bridge (P3.1), pi-task's phase gates (P2.2), and the `TaskExecutor` cascade (P1.2). This is the deliverable for P3.6; source lives in P3.6b.

## Design intent — one paragraph

Verify is an **opt-in** primitive that runs a small fixed panel of reviewer subagents against a plan or a single phase, synthesises their findings, and returns a machine-readable report. It never mutates task status. It never auto-runs. It never invents new reviewer roles. It is the primitive that lets the parent agent say "I claim this phase is done; convince an independent panel."

## Action Signatures

Two callable actions on the existing `plan_tasks` tool.

### `plan_tasks verify`

Verifies the whole plan.

**Parameters (added to the existing `plan_tasks` schema):**

```ts
{
  action: "verify",
  reviewers?: number,       // 1–10, default 4
  reviewerRoles?: string[], // subset of {completeness, correctness, safety, quality}; default: all four
  override?: boolean,       // opt out of block-on-FAIL
  reason?: string,          // required when override is true; non-empty after trim()
}
```

**Response shape** — see [Report Structure](#report-structure).

### `plan_tasks phase-verify`

Verifies a single phase. Identical schema plus `phaseId: string` (required).

```ts
{
  action: "phase-verify",
  phaseId: string,          // required
  reviewers?: number,       // 1–10, default 4
  reviewerRoles?: string[], // as above
  override?: boolean,
  reason?: string,
}
```

## Reviewer Roles

Fixed set of four. Custom-role authoring is a v-next non-goal.

| Role | Prompt intent | Rationale |
| --- | --- | --- |
| **completeness** | Every AC on every task in scope is verifiably met by present artefacts. | Was the work actually done, or just marked done? |
| **correctness** | The implementation matches the spec (design docs referenced by tasks). Divergence-annotated tasks are read against the annotation. | Are there silent deviations? |
| **safety** | No regressions, no removed tests, no removed acceptance criteria, no removed dependents. | Did we get here safely? |
| **quality** | Code health signals: type-checks green, tests green, no lint suppressions added, no scope creep across `files`. | Is the delta shippable? |

Each reviewer runs in a fresh-context subagent (`executor: "subagent-fresh"`) with a fixed prompt scaffold and the plan/phase JSON attached. They return a JSON verdict.

## Report Structure

Shape (TypeBox-compatible sketch):

```ts
const VerifyReviewer = Type.Object({
  role: StringEnum(["completeness", "correctness", "safety", "quality"] as const),
  verdict: StringEnum(["pass", "fail", "warn"] as const),
  findings: Type.Array(Type.Object({
    severity: StringEnum(["blocker", "warn", "note"] as const),
    scope: Type.Union([Type.Literal("plan"), Type.String()]),  // task/phase id or "plan"
    message: Type.String(),
    evidence: Type.Optional(Type.String()),                    // file path or reference
  })),
  transcript: Type.Optional(Type.String()),                    // truncated
});

const VerifyReport = Type.Object({
  verdict: StringEnum(["pass", "fail", "warn"] as const),      // synthesis
  scope: Type.Union([Type.Literal("plan"), Type.String()]),    // "plan" or phaseId
  reviewers: Type.Array(VerifyReviewer),
  synthesis: Type.String(),                                    // ≤ 1000 chars markdown
  artifactPath: Type.String(),                                 // absolute path to persisted report
  timestamp: Type.Number(),
  budgetUsed: Type.Object({
    spawned: Type.Number(),
    cap: Type.Union([Type.Number(), Type.Literal("unknown")]),
  }),
  overrideApplied: Type.Optional(Type.Object({
    reason: Type.String(),
    at: Type.Number(),
  })),
});
```

Synthesis rules:

- Any `fail` from any reviewer → report `verdict: "fail"` (fail-loudest).
- All `pass` → `verdict: "pass"`.
- Otherwise → `verdict: "warn"`.

## Block-on-FAIL semantics

Verify is **advisory to the caller by default**. It writes a report; it does not change task state. But when the plan owner invokes `plan_tasks complete` on the last task of a phase with a verify report present:

- If the most recent report for that phase (by phaseId, matched via `scope`) has `verdict !== "pass"`, the `complete` action **refuses** the transition and returns `{ blocked: true, reason: "verify-fail", reportPath }`.
- **Override** the block by re-invoking `plan_tasks verify` (or `phase-verify`) with `override: true` and `reason: "<non-empty>"`. The report is re-emitted with `overrideApplied` populated and `verdict: "pass"` (synthesis notes the override). Subsequent completes proceed.

Rejection contract for `override` without `reason`:

```
Error: verify --override requires a non-empty --reason.
```

## Opt-in Guarantees

Verify never runs implicitly. Specifically:

- `plan_tasks freeze` / `phase-freeze` do NOT trigger verify.
- `plan_tasks complete` on the final task of a phase does NOT trigger verify.
- The Phase 1 (setup) → Phase N (last) transition does NOT trigger verify.
- No timer / no scheduled auto-verify.

**Skip example (worked)** — you MAY skip verify entirely when:

- The plan has a single phase (or all tasks in `_root`), and
- The plan has fewer than ~5 tasks total, and
- No task has `executor: "subagent-fresh"` (so nothing sensitive got delegated), and
- The plan owner accepts that verify's independent panel will not weigh in.

For everything larger — multi-phase plans, plans with delegated work, plans crossing package boundaries — verify is worth the four reviewer spawns.

**Unit-test AC (informs P3.6b test suite):** a phase with all its tasks completed transitions to `done` in the phase-status output WITHOUT any `verify` or `phase-verify` call, and the plan can be fully completed the same way. The primitive is genuinely opt-in.

## Bridge-Unavailable Failure Modes

When `getSpawnBudget()` returns `{ remaining: "unknown" }` OR when the underlying `subagent` spawn calls fail:

- `verify` returns:

  ```ts
  { unavailable: true, reason: string, verdict: "unknown" }
  ```

  and does NOT throw.

- No report artefact is persisted (nothing to persist).
- The block-on-FAIL mechanic degrades: with no report present, `complete` proceeds normally (the block is only asserted on the presence of a fail report).

This mirrors the bridge's failure contract from P3.1 — the primitive gracefully returns to "you're on your own; the panel didn't get to weigh in."

## Persistence

Report is written to `${plan.scratchDir}/verify/<phaseId-or-plan>/<timestamp>.md`. The markdown wraps the JSON report block plus a human-readable synthesis section. Older reports are NOT auto-pruned in this iteration.

## Non-goals (v-next)

- Custom reviewer roles beyond the four listed.
- Automatic re-verify on plan changes.
- Verify-triggered auto-fix suggestions applied to tasks.
- Cross-plan verify (auditing another plan).
- Verify against a git baseline (a whole other primitive).
