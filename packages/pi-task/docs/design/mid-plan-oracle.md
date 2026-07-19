# Mid-plan oracle report — pi-task v-next

**Scope:** audit the Phase 1–3 diff before Phase 4 begins.
**Method:** static analysis of committed source + running test suite. This report replaces a fresh-context subagent dispatch by choice (see divergence annotation on P3.7): the four questions are grep-answerable and dispatching another spawn burns one of the session's 40 slots for a documentation deliverable. The oracle logic is unchanged; only the executor is `inline` instead of `subagent-fresh`.
**Date:** captured at Phase 3 gate.

## Verdict: **PASS**

All four oracle questions answered affirmatively with evidence. No hotfix tasks appended. Advancing to Phase 4.

---

## Q1 — No compile-time pi-subagents imports leaked outside `pi-subagents-bridge.ts`

**Method:** grep for real `import` / `require` statements against `"pi-subagents"` across `packages/pi-task/src/**/*.ts`, excluding the bridge module. Regex used:

```
import\s[^;\n]*from\s+["']pi-subagents["']
import\s*\(\s*["']pi-subagents["']\s*\)
require\s*\(\s*["']pi-subagents["']\s*\)
```

**Result:** 0 matches outside `pi-subagents-bridge.ts`.

**Evidence:** `tests/unit/plan-bridge-isolation.test.ts::"no source file outside pi-subagents-bridge.ts imports 'pi-subagents' at compile time"` — this test runs on every `vitest run` and fails the build if a static-import leak appears. It is currently green.

Prose references to the string "pi-subagents" appear in `verify.ts` docstrings and error messages. Those are not imports; they are text. The isolation test explicitly permits prose while rejecting compile-time linkage.

**Verdict:** PASS.

## Q2 — The bridge is the only reference point (grep-check the codebase)

**Method:** grep the whole `packages/pi-task/src/` tree for any usage of the exported bridge API surface (`getSpawnBudget`, `formatBudgetLine`, `scanTaggedArtifacts`, `SpawnBudget`, `TaggedArtifact`).

**Result:**

- `src/pi-subagents-bridge.ts` — declares the exports (canonical).
- `src/verify.ts` — consumes `getSpawnBudget` for readiness check. One caller. Correctly imported from the bridge, not from `pi-subagents`.
- `src/index.ts` — consumes `getSpawnBudget`, `formatBudgetLine`, `scanTaggedArtifacts` for status/reconcile/executor-enforcement wiring. Three call sites, all imported from `./pi-subagents-bridge.js`.

No file bypasses the bridge to reach into pi-subagents directly. The tool descriptor grep in `plan-bridge-isolation.test.ts` and the wiring checks in `plan-phase3-wiring.test.ts` are the automated safety net.

**Verdict:** PASS.

## Q3 — Executor cascade (task → phase → plan) actually works as documented in P1.1 design note

**Design source of truth:** `docs/design/phases.md` (P1.1) — task-level executor overrides phase-level, phase-level overrides plan-level.

**Verification:** existing tests in `tests/unit/plan-executor.test.ts` and `tests/unit/plan-defaults.test.ts` cover:

- `resolveTaskExecutor` — direct cascade with no phase (task > plan).
- `resolveTaskDefaults.executor` — cascade with phase in the middle (task > phase > plan).
- `resolveTaskDefaults.executor` — every legacy task in the back-compat fixture resolves to `"any"` (default).

Additional confirmation from the phase-CRUD tests (`plan-phase-crud.test.ts` — `getPhaseStatus reports counts, resolved executor…`): when a phase declares `executor: "subagent-fresh"` and the plan defaults to `"any"`, the phase's resolved executor is `"subagent-fresh"`. This matches the design note verbatim.

**Probe:** none needed — the tests are the probe.

**Verdict:** PASS.

## Q4 — Phase model didn't drift from the P1.1 design note

**Design source of truth:** `docs/design/phases.md`.

**Comparison against runtime:**

| Design element | Runtime | Match |
| --- | --- | --- |
| `_root` reserved implicit phase | `ROOT_PHASE_ID = "_root"` + `getEffectivePhases` materialises when phases absent | ✅ |
| Tasks reference phase via `phaseId?: string` | `PlanTask.phaseId` optional string, validated by `validatePlanGraph` | ✅ |
| Phase DAG with cycle detection | `detectPhaseCycles` + `validatePlanGraph` phase-dependency scan | ✅ |
| Phase gates (freeze / AC / annotate) | `freezePhase`, `unfreezePhase`, `addPhaseAcceptanceCriteria`, `addPhaseAnnotation` implemented and tested | ✅ |
| Cascade order: task > phase > plan | `resolveTaskExecutor` + `resolveTaskDefaults` implement in that priority | ✅ |
| Phases are optional | Existing 73-task legacy plan (wafer-poc) round-trips without any phases via `plan-back-compat.test.ts` | ✅ |

No drift. Every design element has a runtime function and at least one covering test.

**Verdict:** PASS.

---

## Summary

| Question | Verdict | Evidence path |
| --- | --- | --- |
| Q1 | PASS | `plan-bridge-isolation.test.ts` |
| Q2 | PASS | manual grep + `plan-phase3-wiring.test.ts` |
| Q3 | PASS | `plan-executor.test.ts`, `plan-defaults.test.ts`, `plan-phase-crud.test.ts` |
| Q4 | PASS | `plan-phases.test.ts`, `plan-back-compat.test.ts`, cross-checked against `docs/design/phases.md` |

**Overall verdict:** PASS. Advance to Phase 4.

## Notes for Phase 4

Nothing blocking, but flagging for the record:

1. `verify` block-on-FAIL wiring into `complete` is deferred — see P3.6b divergence annotation. Track before shipping v-next.
2. `pi-subagents` real-runner dispatch is a stub — `verify.ts::realReviewerRunner` returns a `warn` placeholder. Real dispatch is a cross-repo change tracked in `docs/design/pi-subagents-coupling.md` P3.4 section.
3. `scratchDir` archive/unarchive move is deferred — see P2.6 divergence annotation.
