---
name: planning
description: >
  DoD-aware planning methodology that produces self-contained, verifiable task plans.
  Every task gets acceptance criteria a blind reviewer can verify, references for context,
  constraints, non-goals, and danger zones. Use when creating or updating plans via plan_tasks,
  Plannotator, babysitter, or plain markdown. Triggers on: plan creation, task planning,
  "plan this", "create tasks", "break this down", acceptance criteria, Definition of Done,
  DoD, "what does done mean", freeze criteria. Do NOT use for executing/implementing tasks
  — this skill is for planning phase only.
---

# Planning: Self-Contained, Verifiable Task Plans

Plans exist so any agent can pick up a task cold and execute it without discovery overhead.
A plan without acceptance criteria is a wish list. A plan without references is a scavenger hunt.

## Core Rule

Every task MUST answer three questions an independent reviewer can verify:
1. **What is done?** — Acceptance criteria (observable, testable conditions)
2. **Where is context?** — References (skills, files, docs, repos, memory)
3. **What is NOT done?** — Non-goals and constraints (explicit boundaries)

## Planning Granularity

Match depth to risk. Don't over-plan spikes. Don't under-plan features.

| Work type | Tasks | ACs per task | References needed? |
|-----------|-------|--------------|--------------------|
| Spike / exploration | 1 | 0-1 ("learned X") | Minimal |
| Bug fix | 1-2 | 2-3 ("reproducer + fix + no regression") | File + test path |
| Single feature | 2-5 | 2-4 each | Skills + files + related |
| Multi-session epic | 5-15 | 3-5 each | Full references + ADR |

**Decision rule**: If a single task has >5 ACs, split it. If a plan has >15 tasks, group into phases.

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

**Bad criteria** are vague, narrative, or untestable:
```
❌ "Implement the auth flow"
❌ "Make it work correctly"  
❌ "Improve performance"
❌ "Handle edge cases"
```

**Sharpening vague criteria**: When a criterion feels soft, apply these transforms:
- Replace adjectives with measurements: "fast" → "<100ms p99"
- Replace "properly" with the observable behavior: "properly handles" → "returns 400 with {error: ...}"
- Add the `Verify:` line — if you can't write it, the criterion is untestable
- Ask: "Could two reviewers disagree about whether this passes?" If yes, sharpen it.

**Conversion technique**: Ask "How would a reviewer who never saw the code PROVE this is done?"
If the answer requires reading the implementation reasoning, the criterion is too vague.

## References

Every task should include what the implementing agent needs to load BEFORE writing code:

| Field | When to include | Example |
|-------|-----------------|---------|
| `skills` | When domain-specific methodology applies | `["go-dev", "go-testing", "coding-discipline"]` |
| `files` | Key source files, configs, ADRs to read first | `["internal/auth/handler.go", "docs/adr/003-auth.md"]` |
| `repos` | External repos with relevant patterns | `["github.com/some/library"]` |
| `docs` | External documentation, specs, RFCs | `["https://pkg.go.dev/context"]` |
| `memory` | Memory keys with relevant project decisions | `["project.auth.design", "pref.testing.order"]` |
| `related` | Other tasks that share context or decisions | `["task-2", "task-5"]` |

**Rule**: If you find yourself thinking "the agent will need to discover X", put X in references.

## Constraints and Non-Goals

Constraints prevent scope creep and protect invariants:
- "Must not change the public API signature"
- "Must work with existing auth middleware — no new dependencies"
- "Performance must not regress: <100ms p99 latency"

Non-goals make boundaries explicit:
- "Not implementing the admin UI — only the API endpoint"
- "Not optimizing for concurrent access yet — single-writer is fine"
- "Not migrating existing data — only new records use the new schema"

## Final Sanity Check

Before calling `plan_tasks create`, verify:

- [ ] `dependsOn` forms a valid DAG (no circular deps)
- [ ] Tasks with overlapping files are sequential (not parallel)
- [ ] Every AC has a `Verify:` method a blind reviewer can execute
- [ ] No task has >5 ACs (split it)
- [ ] Non-trivial tasks have at least one non-goal
- [ ] `parallelGroup` tasks have zero file overlap

## Freezing Criteria

After planning is complete and before building starts:
1. Present criteria to user via `ask_user` for structured confirmation
2. Call `plan_tasks freeze` to lock criteria immutable
3. Frozen criteria become the contract reviewers verify against

Only `unfreeze` if a genuine requirement change occurs — not because implementation is hard.

## Anti-Patterns

- **Plan without criteria**: "Implement feature X" with no definition of done → agent uses the description as its exit condition, so any output that vaguely matches satisfies its internal "am I done?" heuristic
- **Criteria without verification method**: "App is responsive" → no reviewer can check this, so verification becomes a rubber stamp that always passes
- **Missing references**: Agent's first 3-5 tool calls become blind discovery (grep/find/read), producing lower-quality understanding than targeted reads because it doesn't know what it's looking for
- **Scope creep via omission**: No non-goals → agent's helpfulness bias fills every adjacent gap it notices, multiplying the diff surface area for review
- **Vague dependencies**: Tasks with implicit ordering → parallel workers stomp each other's files or build on uncommitted assumptions


