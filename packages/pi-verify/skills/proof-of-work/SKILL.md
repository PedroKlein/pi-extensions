---
name: proof-of-work
description: >
  Implementation discipline for producing verifiable evidence during build work.
  Replaces "I did it" claims with durable proof artifacts. Use when building features,
  fixing bugs, or implementing any planned work where verification matters. Triggers on:
  build mode with strict verification, "prove it works", "show evidence", TDD cycle,
  implementation with acceptance criteria, any task with frozen criteria. Do NOT use for
  planning (use planning skill) or post-work verification (use verify skill).
---

# Proof of Work: Evidence Over Claims

A claim without evidence is worthless. "Tests pass ✓" without showing what was tested
proves nothing. This skill makes you produce durable proof as you work.

## Core Principle

For every piece of work, produce an artifact that a blind reviewer can inspect to
confirm the work was done. The reviewer never saw your implementation session.
They only see: the plan, the criteria, and your proof artifacts — produced AFTER
loading all task references (skills, files, memory keys). No exceptions.

## Evidence Types by Work Category

### Code Changes
**Required proof:** Test output showing meaningful assertions

Not this:
```
✓ 52 tests passed
```

This:
```
✓ freezeTask throws when no criteria defined
  Assert: expect(() => freezeTask(graph, "task-1")).toThrow("no acceptance criteria")
✓ frozen task blocks criterion updates  
  Assert: expect(() => updateTask(graph, "task-1", { acceptanceCriteria: [...] })).toThrow("frozen")
✓ unfreeze allows modification
  Assert: updated.tasks[0].frozen === false
```

Show WHAT is asserted, not just the count. A reviewer must see the assertions exercise the actual change.

### UI Work
**Required proof:** Screenshots via `agent_browser`

```
// Take screenshot after implementing the feature
agent_browser({ qa: { url: "http://localhost:3000/feature", expectedText: "Success" } })
agent_browser({ args: ["screenshot", "proof/feature-complete.png"] })
```

Screenshots prove the UI renders correctly. A reviewer can see the state.

### API/Backend Work
**Required proof:** Request/response transcripts

```bash
# Show the endpoint works with expected input/output
curl -s localhost:8080/api/tasks/freeze -X POST -d '{"taskId":"task-1"}' | jq .
# Expected: {"frozen": true, "taskId": "task-1"}
```

### Non-Code Work
**Required proof:** Before/after comparison showing the change

| Work type | Evidence |
|-----------|----------|
| Documentation | Diff showing content improvement (not just reformatting) |
| Dependency updates | Lockfile diff + full test suite passes |
| Config changes | Before/after state (kubectl diff, env comparison) |
| Refactoring | Tests still pass + metrics unchanged + diff review |
| Performance | Benchmark output before/after with statistical significance |

## Evidence Quality Ladder

From weakest to strongest — always aim for the highest level achievable:

1. 🟥 **Claim**: "I did it" — worthless
2. 🟧 **Screenshot/transcript**: Proves state at one moment — fragile
3. 🟨 **Test exists**: Test file present — doesn't prove it exercises your change
4. 🟩 **Meaningful assertions**: Test fails if change is reverted — solid proof
5. 🟦 **Criterion-mapped assertions**: Each AC has a named test — blind reviewer can verify

## Meaningful Assertions Checklist

Before claiming tests prove your work, verify:

| Check | Why |
|-------|-----|
| Would the test FAIL if you reverted your change? | Proves the test exercises your code |
| Does the assertion check behavior, not implementation? | Survives refactoring |
| Is there at least one error/edge case test? | Happy path alone proves little |
| Does the test use realistic inputs? | Toy inputs miss real bugs |

## Anti-Patterns

- **"Tests pass"** without showing assertions → reviewer can't verify what was tested
- **Testing the mock** — assertion verifies the mock setup, not the real code. Ask: "If I deleted my implementation, would this test still pass?" If yes, it's testing the mock.
- **Tautological tests** — `expect(fn()).toBeDefined()` proves the function exists, not that it works
- **Coverage theater** — touching lines without exercising edge cases or error paths
- **Screenshot of code** instead of screenshot of running UI — code is not evidence of behavior
- **"I ran it locally and it works"** — no durable artifact a reviewer can inspect
- **Happy path only** — one passing test for the golden path; no error, edge, or boundary tests
- **Existing tests "good enough"** — if tests exist but don't meet the meaningful assertions checklist, add assertions to them. Show the before/after assertion diff as evidence.

## Proof Artifact Format

After implementing, produce a structured summary:

```
## Proof of Work: [task-id]

### What was implemented
[1-2 sentence summary]

### Evidence
1. Tests: [test file path]
   Key assertions:
   - [assertion 1 — what it verifies]
   - [assertion 2 — what it verifies]
   Result: [pass/fail with command output]

2. Lint/Typecheck: [command and result]

3. [Screenshots / transcripts / other evidence]

### Acceptance Criteria Mapping
- AC1: [criterion] → Verified by: [test name / evidence]
- AC2: [criterion] → Verified by: [test name / evidence]

### What's unverified
- [anything that couldn't be proven, with reason]
```

## Promote Failing Cases to Tests

When a reviewer finds a bug or a re-verification catches a regression, that failing case is a free test. Don't throw it away after the fix:

1. Reviewer says: "Input: empty array causes crash on line 42"
2. Fix the bug
3. Write a test that reproduces the exact failing case: `expect(() => fn([])).not.toThrow()`
4. That test now permanently guards against reintroduction

Every verification failure that becomes a test compounds the value of the review. Over time, the test suite learns what the reviewers keep catching, closing the gap from both sides.

