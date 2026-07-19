# pi-subagents coupling

Design contract for how `pi-task` reads live subagent state from `pi-subagents` at runtime, without any compile-time coupling. Applies to P3.1–P3.5.

## Compatibility strategy

pi-task must run in every configuration where pi-subagents can be:

- Installed alongside pi-task and loaded in the same Node process (the common case).
- Absent from the runtime — pi-subagents is optional and can be removed.
- Installed at a version that does not yet export the probe surface described here.

The bridge module (`src/pi-subagents-bridge.ts`) is the **only** file in pi-task that references pi-subagents. All references go through a dynamic `import("pi-subagents")` call. There is no compile-time `import type` reference to pi-subagents anywhere else in the package. This isolation is verified in two places:

1. Grep test in `tests/unit/plan-bridge-isolation.test.ts` (P3.1 test bundle).
2. P3.7 mid-plan oracle re-verifies before P4 begins.

Version-compat is expressed as **feature detection at runtime**, not `peerDependencies` version pins. The bridge probes the imported module for two possible shapes:

| Shape | Function | Emitted by pi-subagents version |
| --- | --- | --- |
| Modern | `getSpawnBudget(): SpawnBudget \| Promise<SpawnBudget>` | ≥ v-next (to be shipped) |
| Legacy | `getBudget(): {spawned, cap, activeRuns}` | If a pre-existing export matches this shape |
| Absent | (neither) | Older versions — bridge returns `unknown` |

Version handshake is **lossless**: any pi-subagents version pi-task doesn't recognise returns `{ remaining: "unknown", reason: "no-probe-export" }` from the bridge. Nothing throws, callers degrade gracefully.

## API surface (P3.1)

```ts
export interface SpawnBudget {
  spawned:    number | "unknown";
  cap:        number | "unknown";
  remaining:  number | "unknown";
  activeRuns: number | "unknown";
  reason?: string;                     // populated when any field is "unknown"
}

export async function getSpawnBudget(): Promise<SpawnBudget>;
export function formatBudgetLine(budget: SpawnBudget): string;
```

Semantics:

- **Never throws.** Any failure (missing package, missing export, thrown probe, malformed response) collapses to `UNKNOWN_BUDGET` with a hint in `reason`.
- **Rate-limited logging.** The first failure prints one warn line to stderr; subsequent probe calls stay silent for the session. Test hook `_resetProbeLogGateForTests` resets the gate for unit tests.
- **Read-only.** The bridge does not mutate pi-subagents state. Write-back is an explicit non-goal for this iteration (see P3.1 non-goals).

## Failure modes

Ordered from most-benign to most-severe:

1. **pi-subagents not installed.** Dynamic import rejects synchronously. Bridge returns `unknown` with `reason: "Cannot find module 'pi-subagents'"` or similar. Every dependent surface (status line, executor enforcement) degrades to warn-only.
2. **pi-subagents installed but no probe export.** Import succeeds, but neither `getSpawnBudget` nor `getBudget` is defined. Bridge returns `unknown` with `reason: "no-probe-export"`. Same downstream behaviour as above.
3. **Probe throws.** The exported function is called and raises. Bridge catches, returns `unknown` with the error message as `reason`.
4. **Probe returns malformed data.** e.g., non-numeric `spawned`. Bridge coerces to `unknown` with `reason: "malformed-probe-response"` rather than passing lies downstream.
5. **Probe deadlocks.** Not currently guarded (no watchdog). Acceptable for this iteration — pi-subagents is in-process, and a permanent-hang in its budget accessor is a bigger crisis than pi-task's status output. Track as follow-up if this becomes real.

## Consumer contracts

Consumers of `getSpawnBudget()`:

- **P3.2** `plan_tasks status`: renders `formatBudgetLine(budget)` verbatim. Any `"unknown"` field produces `"spawns: probe-unavailable"`. Callers must not fabricate numbers from partial data (the wafer-poc `37/40` hallucination is the negative case study; see `design-briefs/plan-tasks-broader-learnings.md`).
- **P3.3** executor enforcement on `start`: reads `remaining`. If numeric and `0` and the task's resolved executor is `subagent-fresh` or `subagent-fork`, `start` returns `{ blocked: true, reason: "subagent-budget-exhausted", escalation: {...} }`. If `remaining === "unknown"`, `start` proceeds with a warn-annotation on the task rather than blocking.
- **P3.5** `plan_tasks reconcile`: reads `scanTaggedArtifacts()`; matches on task ID.

## Artifact task-ID metadata protocol (P3.4)

`pi-task` needs to know which subagent artifacts belong to which task. The current pi-subagents artifact-metadata schema is silent on this. We extend it as follows:

**Schema — `metadata.json` (per-run):**

```jsonc
{
  "runId": "abc123",
  "startedAt": 1734567890000,
  "endedAt":   1734567891234,
  "agent":     "reviewer",
  "status":    "success",
  // NEW FIELDS (P3.4):
  "taskId":    "P3.5",           // optional; pi-task task ID from `plan_tasks`
  "planName":  "pi-task-v-next"  // optional; the plan the taskId belongs to
}
```

Field semantics:

- `taskId` is a string; opaque to pi-subagents. Callers (the main agent) supply it when spawning.
- `planName` is a string; disambiguates when multiple plans share task-ID prefixes.
- Both fields are optional. Absent = the artifact does not link back to a task.

**Emission side (pi-subagents):**

- The `subagent` tool grows two optional parameters `taskId?: string` and `planName?: string`.
- The runner writes them into `.pi-subagents/artifacts/<runId>/metadata.json` verbatim, no interpretation.
- Consumer coordination: link a pi-subagents-side tracking issue from this doc before shipping. **Cross-repo change is deferred**; this document is the coordination artefact until then. Prototype patch: pending. Placeholder link: [pi-subagents artifact-metadata extension](https://github.com/PedroKlein/pi-extensions/issues/PLACEHOLDER-P3.4).

**Consumption side (pi-task, P3.5):**

- `scanTaggedArtifacts()` reads the last 100 artifacts, filters for `metadata.taskId`, returns `TaggedArtifact[]`.
- Matching is exact on `taskId`. When `planName` is present on both sides, it must match too; on absence, we tolerate.
- `plan_tasks reconcile` and `plan_tasks status` surface matches as **offers only** — never auto-complete.

## Non-goals (this iteration)

- Write-back to pi-subagents state. Pi-task never spawns runs itself in this iteration; it only reads.
- Hard-blocking on any pi-subagents dependency. Every feature degrades cleanly when the bridge returns `unknown`.
- Custom coupling per pi-subagents version. Version detection is done exclusively via feature-detection on the imported module, not by version-string sniffing.

## Testing surface

Every consumer of the bridge is tested with three states:

- Bridge returns a happy `SpawnBudget` (mock inject).
- Bridge returns `unknown` (test hook `_setBridgeMock("disabled")`).
- Bridge throws internally — swallowed to `unknown` with `reason` (test hook injects a throwing probe).

`_resetProbeLogGateForTests()` is called in `beforeEach` for tests that assert on stderr output.

## Change log

| Rev | Task | Summary |
| --- | --- | --- |
| 1 | P3.1 | Initial contract, SpawnBudget shape, dynamic-import isolation |
| 1 | P3.4 | Artifact task-ID metadata protocol (taskId + planName) documented |
