# pi-verify

Freeze acceptance criteria, spawn independent reviewers, get evidence-based verdicts on your work.

## Install

```bash
pi install npm:@pedro_klein/pi-verify
```

Requires [pi-task](../pi-task) (provides `plan_tasks` with acceptance criteria) and [pi-subagents](https://github.com/nicobailon/pi-subagents) (provides RPC reviewer spawning).

## How It Works

1. Plan tasks with acceptance criteria (`plan_tasks add-criteria`)
2. Lock criteria immutable (`/freeze`)
3. Build the implementation
4. Spawn 4 blind reviewers (`/verify`)
5. Each reviewer independently checks the work against the frozen contract
6. Fix failures, re-verify until all pass

Reviewers never see the implementation session. They get only: frozen criteria, git diff, and repo access. This structural separation prevents "I know what you meant" bias.

## Commands

### /freeze

Locks all acceptance criteria in the active plan. Once frozen, criteria cannot be modified until explicitly unfrozen.

Checks that tasks have criteria defined. Emits `pi-verify:frozen` event on success.

### /verify

Spawns 4 specialized reviewers as async subagents:

| Reviewer | Checks | Model | Why that model |
|----------|--------|-------|----------------|
| Completeness | Every AC addressed, nothing missed | Opus | Thoroughness over speed |
| Correctness | Tests pass and exercise the actual change | Sonnet | Can run tests, fast enough to iterate |
| Quality | Code patterns, codebase fit, practices | GPT | Different training data catches different smells |
| Safety | Blast radius, regressions, side effects | Opus | Conservative assessment needs deep reasoning |

Each reviewer produces a structured verdict: PASS, FAIL, PARTIAL, CAUTION, or CONCERNS.

## Tools

### freeze_criteria

Programmatic freeze for orchestrators and chains.

**Parameters:**
- `taskId` (string, optional): Freeze a specific task. Omit to freeze all tasks with criteria.

**Returns:** Result from `plan_tasks freeze`.

**Events emitted:** `pi-verify:frozen`

```
freeze_criteria({ taskId: "task-1" })  // one task
freeze_criteria({})                      // all tasks
```

### verify_work

Spawns all 4 reviewers and returns their spawn status.

**Parameters:**
- `taskId` (string, optional): Verify a specific task's criteria. Omit to verify all.
- `context` (string, optional): Additional context passed to reviewers (e.g., focus areas).

**Returns:** Spawn results per reviewer, list of criteria being verified, instructions for checking results.

**Events emitted:** `pi-verify:started`

```
verify_work({})                                    // all criteria
verify_work({ taskId: "task-1" })                 // one task
verify_work({ context: "focus on the API layer" }) // hint reviewers
```

## Skills

Two skills ship with this package and are auto-discovered on install:

| Skill | Teaches | Load when |
|-------|---------|-----------|
| `proof-of-work` | Producing verifiable evidence during implementation | Building anything with frozen criteria |
| `verify` | When and how to freeze/verify, interpreting verdicts, failure recovery | Deciding whether to verify, reading reviewer output |

## Events

| Event | Emitted when | Payload |
|-------|-------------|---------|
| `pi-verify:frozen` | Criteria locked via /freeze or freeze_criteria | `{ tasks: string[], timestamp: number }` |
| `pi-verify:started` | Verification launched via /verify or verify_work | `{ criteria: string[], timestamp: number }` |

## Reviewer Agents

Reviewers are `.md` files in `~/.pi/agent/agents/`. Each defines a model, tools, system prompt, and verdict format.

| File | Role |
|------|------|
| `completeness-reviewer.md` | Checks every AC has evidence |
| `correctness-reviewer.md` | Runs tests, validates assertion quality |
| `quality-reviewer.md` | Compares against project patterns |
| `safety-reviewer.md` | Maps blast radius, finds regressions |

All reviewers share: `acceptanceRole: read-only`, `defaultContext: fresh`, structured verdict output.

To change a reviewer's model or behavior, edit its `.md` file directly.

## Integration

**As a plan step:**
```json
{
  "id": "verify-all",
  "title": "Verify acceptance criteria",
  "dependsOn": ["all-implementation-tasks"],
  "acceptanceCriteria": ["All 4 reviewers return PASS"]
}
```

**In orchestrator workflows:**
plan, implement, verify, fix, re-verify

**Manual:**
`/freeze` then `/verify` when the work is done.

## Architecture Decisions

**Blind grading.** Reviewers get fresh context. They never saw the implementation conversation. This prevents confirmation bias.

**Model diversity.** Different providers per reviewer. A single model has systematic blind spots from its training data. Cross-provider review catches more.

**RPC dispatch.** Reviewers spawn via `subagents:rpc:v1` event bus. Any runner implementing this protocol works.

**Immutable criteria.** Once frozen, the contract is fixed. This removes the temptation to weaken requirements when implementation gets hard.

**Read-only reviewers.** Reviewers inspect and run tests but cannot modify code. Separation of concerns: the doer builds, the checker checks.

## License

MIT
