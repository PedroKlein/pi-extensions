# @pedro_klein/pi-task

## 0.4.0

### Minor Changes — v-next (pi-task-v-next plan)

Major iteration adding first-class phases, an executor cascade, verify primitive,
and a coupling contract with pi-subagents. Every schema change is additive; the
real 73-task wafer-poc plan round-trips byte-identically (`plan-back-compat.test.ts`).

#### Schema

- `Phase` interface added — first-class group with own `acceptanceCriteria`,
  `executor`, `defaults`, `frozen`, `dependsOn`, and annotations.
- `PlanGraph.phases?` and `PlanGraph.defaults?` (plan-level defaults).
- `PlanGraph.scratchDir?` — every plan owns a scratch directory, defaults to
  `<plansRoot>/<planName>/scratch`.
- `PlanGraph.frozen?` — plan-level freeze bit, set implicitly on first `start`.
- `PlanTask.phaseId?` — optional phase membership. Absence = implicit `_root` phase.
- `PlanTask.executor?` — task-level executor override.
- `TaskAnnotation.category?` and `PhaseAnnotation.category?` — `note` (default) |
  `divergence` | `blocker` | `decision`.

#### Actions

- **Phases:** `phase-create`, `phase-update`, `phase-delete`, `phase-status`,
  `phase-ac`, `phase-freeze`, `phase-unfreeze`, `phase-annotate`.
- **Verify (opt-in):** `verify`, `phase-verify`. Four reviewer roles, TypeBox-
  validated report, `--override --reason` protocol, degrades to `{unavailable: true}`
  when the pi-subagents bridge is missing.
- **Reconcile:** `reconcile` scans tagged subagent artifacts and offers matches
  against open tasks; advisory only, never auto-completes.
- **`get --verbose`** returns raw + resolved snapshots (defaults cascade applied).
- **`annotate` / `phase-annotate`** accept optional `category`.
- **`complete` / `bulk-complete`** now require non-empty `divergence` when the
  target task is not `in-progress`. Auto-annotates the target with a
  `divergence`-category annotation.
- **`start`** implicitly freezes the plan on first invocation and enforces the
  executor cascade: blocks with `{blocked: true, reason}` for `user` executor,
  for `subagent-fresh|fork` when budget is exhausted, otherwise proceeds. When
  the pi-subagents budget probe is unavailable, `start` proceeds with a warn
  annotation.

#### Coupling

- **`pi-subagents` bridge** (`src/pi-subagents-bridge.ts`): the ONLY file in
  pi-task that references pi-subagents. Uses runtime feature-detection
  (`import()` assembled at call time so tsc doesn't resolve the module). Never
  throws — degrades to `{ remaining: "unknown", reason }` on any failure path.
  Rate-limited failure logging. Companion pi-subagents patch is required for
  the artifact-metadata protocol (P3.4) — see
  `docs/design/pi-subagents-coupling.md` for the field spec (`taskId`,
  `planName`) and coordination-issue placeholder.
- **Plan mutex** (`src/plan-mutex.ts` + `mutateActivePlan`): every mutating
  case block routes through a per-plan async mutex, fixing the pre-v-next
  load-mutate-save race. See `docs/design/concurrency.md`.

#### Skills

- **`planning`** rewritten: AC-format moved to top; new Choosing-an-Executor
  section with calibration examples from the wafer-poc plan; three new
  anti-patterns (`parallelGroup` without executor, description-as-AC, two
  sources of truth); sub-task guidance reshaped to name three valid patterns
  (per-file, per-target, TDD); implicit-freeze semantic documented; reference
  example at `examples/multi-session-refactor.md`. skill-judge audit: 108/120.
- **`building`** (new): the execution-loop skill for build mode. Covers when to
  `start`, when to `bulk-complete`, handling plan drift with divergence, and
  the handoff shape including the 37/40 negative case study.
  skill-judge audit: 111/120.

#### Widget

- Phased plans render with phase headers showing per-phase `done/total`,
  executor, frozen, and dependency badges. Phase acceptance criteria are shown
  inline.
- Legacy plans (no phases) render unchanged.
- Task rendering adds `[executor: ...]`, `[phase: ...]`, `⚠️ divergence`, and
  `🛑 blocker` badges.
- Plan header shows `🧊 frozen` and `scratchDir: <path>` when set.
- `plan_tasks status` output ends with the live spawn-budget line
  (`spawns: N/M remaining · K active runs` or `spawns: probe-unavailable`) and a
  Pending-completions section when tagged artifacts exist.

#### Documentation

- Diataxis-structured docs under `packages/pi-task/docs/`:
  - `reference/plan-tasks-actions.md` — authoritative action + field reference.
  - `explanation/phases-and-executors.md` — concept doc with the 37/40 case study.
  - `how-to/author-multi-phase-plan.md` — end-to-end walkthrough.
- Design docs under `docs/design/`: `phases.md`, `concurrency.md`,
  `pi-subagents-coupling.md`, `verify.md`, `mid-plan-oracle.md`,
  `skill-audits/{planning,building}.md`, `humanizer-report.md`.
- Dogfood recording at `tests/e2e/pi-task-v-next-dogfood.md`.

#### Retirements (one-release deprecation window)

- `add-criteria` — deprecated. Emits one-time stderr warning. Use `update` with
  `updates.acceptanceCriteria`. Rejected outright on a frozen plan.
- `references.related` — silently deprecated. Move linked task IDs into task
  descriptions.
- `expand` — deprecated alias for `add-subtasks`. Emits one-time stderr warning.

#### Companion patches

- **pi-subagents artifact-metadata protocol** (P3.4): pi-subagents must add
  `taskId?` and `planName?` fields to `.pi-subagents/artifacts/<runId>/metadata.json`
  emissions. Coordinating issue placeholder documented in
  `docs/design/pi-subagents-coupling.md`. Until landed, `scanTaggedArtifacts()`
  returns `[]` in production; unit tests use `_setArtifactScanMock`.

## 0.3.0

### Minor Changes

- pi-task: Improve tool usability for agents with 6 new actions:

  - `add` — append tasks to existing plan (no more recreating the whole plan)
  - `start` — mark task as in-progress
  - `add-subtasks` — clearer alias for `expand`
  - `bulk-complete` / `bulk-skip` — complete/skip multiple tasks at once
  - `delete-plan` — permanently remove a plan from disk

  Also improved promptGuidelines to teach agents the full lifecycle.

  pi-memory: Add `dev` watch script.

## 0.2.0

### Minor Changes

- fb8198c: Standardize all packages for npm publishing

  Every package now follows the same canonical structure:

  - Source moved to `src/` directory (pi loads TypeScript directly)
  - All `@mariozechner/*` imports replaced with `@earendil-works/*`
  - Added `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` to each package
  - Normalized `package.json`: proper `exports`, `files: ["src"]`, `pi.extensions`, `repository`, `homepage`
  - README rewritten with structured sections (Install → What it provides → Config → How it works → Development)
  - Added unit tests to every package (531 tests total across 14 packages)
  - Fixed `pi.skills` manifest in pi-repos, `pi.prompts` manifest in pi-modes
  - Fixed pi-readonly-bash (was missing version, main, files, scripts)
  - Added `mkdir` to bash policy denylist (pi-readonly-bash bug fix)
