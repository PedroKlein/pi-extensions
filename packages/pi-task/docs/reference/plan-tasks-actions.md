# `plan_tasks` — actions and fields reference

Authoritative reference for every action on the `plan_tasks` tool. Grouped by concern.
For narrative and rationale, see [Explanation → Phases & Executors](../explanation/phases-and-executors.md).
For a walkthrough of authoring a plan, see [How-to → Author a multi-phase plan](../how-to/author-multi-phase-plan.md).

## Fields (new in v-next)

### `executor` (task, phase, plan.defaults, phase.defaults)

Five values in cascade order (task > phase > plan.defaults > `any`):

| Value | Meaning |
| --- | --- |
| `any` | No preference. Default. Runtime picks. |
| `inline` | Run in the current agent's context; no spawn. |
| `subagent-fresh` | Spawn a fresh-context subagent (no parent history). |
| `subagent-fork` | Spawn a forked-context subagent (shares parent context). |
| `user` | Human executes. Agent hands off. |

### `phaseId` (task)

Optional string. When set, the task belongs to that phase. Absence = the implicit
`_root` phase. The ID `_root` is reserved.

### `plan.defaults` / `phase.defaults`

Optional. Both accept the same shape:

```ts
{
  executor?: TaskExecutor;
  parallelGroup?: string;            // phase.defaults only
  referenceSkills?: string[];
  referenceFiles?: string[];
  constraints?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
}
```

Scalar fields cascade with override (task > phase > plan). Array fields cascade with
concat + dedupe, task-first order.

### `scratchDir` (plan)

Optional absolute path. If unset on `create`, defaults to
`<plansRoot>/<planName>/scratch`. Referenced in tasks via the `{scratchDir}` template
variable — expanded at read time by `plan_tasks get --verbose`.

### `frozen` (plan)

Set implicitly to `true` on the first `start`. Blocks `add-criteria` and rejects
edits to task acceptance criteria via `update`. See Explanation for the rationale.

### Annotation category

`plan_tasks annotate` and `phase-annotate` accept an optional `category`:

| Value | Meaning |
| --- | --- |
| `note` | Default. Informational. |
| `divergence` | Reality departed from the plan. Emits ⚠️ badge in status output. |
| `blocker` | Task cannot proceed. Emits 🛑 badge. |
| `decision` | Design or scope decision recorded on the task. |

Runtime-emitted annotations (e.g. from `complete` with `divergence`) always use
category `divergence`.

## Actions — task lifecycle

### `create`

Params: `planName`, `tasks[]`, optional `sourceCheckpoint`, optional `scratchDir`.
Creates the plan, materialises the scratch directory, sets the plan active.
Returns: `{ plan, scratchDir }`.

### `add`

Params: `tasks[]`. Appends tasks to the active plan. Duplicate IDs rejected.

### `update`

Params: `taskId`, `updates`. Rejects on a frozen plan for `acceptanceCriteria`.
`updates.executor` accepts any of the five values.

### `start`

Params: `taskId`. Implicit freeze on first start. Executor-aware:

- `executor: "user"` → returns `{ blocked: true, reason: "awaiting-user" }`.
- `executor: "subagent-fresh"` or `"subagent-fork"` and budget exhausted → returns
  `{ blocked: true, reason: "subagent-budget-exhausted", escalation: {...} }`.
- `executor: any` / `inline` → proceeds unconditionally.

### `complete`

Params: `taskId`, optional `subtaskId`, optional `divergence`.
When task status is not `in-progress`, `divergence` is required (non-empty after
trim). On success, a `divergence`-category annotation is auto-appended when
divergence is supplied. Sub-tasks bypass the divergence gate.

### `skip`

Params: `taskId`, optional `subtaskId`. Sets status to `skipped`.

### `bulk-complete`

Params: `taskIds[]`, optional `divergence`. Divergence is required when any target
is not in-progress; the same divergence is annotated onto every un-started target.

### `bulk-skip`

Params: `taskIds[]`. Sets all to `skipped`.

### `annotate`

Params: `taskId`, `text`, optional `category` (see Fields).

### `freeze` / `unfreeze`

Freeze locks a task's acceptance criteria until unfrozen. `freeze` without
`taskId` freezes all tasks that have criteria. See also implicit-freeze under
`start`.

### `add-criteria` — deprecated

Deprecated. Emits a one-time stderr warning. Use `update` with
`updates.acceptanceCriteria` instead. Rejects when plan is frozen.

### `reorder`

Params: `taskId`, `updates.order`. Changes task ordering only.

### `delete`

Params: `taskId`, optional `subtaskId`. Also removes dangling `dependsOn`
references from surviving tasks.

### `expand` / `add-subtasks`

`expand` is an alias for `add-subtasks` and emits a deprecation warning.
Params: `taskId`, `newSubtasks[]`.

### `update-subtask`

Params: `taskId`, `subtaskId`, `updates.title?`, `updates.description?`.

## Actions — phase lifecycle

### `phase-create`

Params: `phase` (object). Rejects duplicate IDs and the reserved `_root` ID.
Fields: `id`, `title`, `description?`, `order?`, `dependsOn?`,
`acceptanceCriteria?`, `executor?`, `defaults?`.

### `phase-update`

Params: `phaseId`, `phase`. Only supplied fields are updated. Rejects
`acceptanceCriteria` edits when the phase is frozen.

### `phase-delete`

Params: `phaseId`. Rejects if any task references the phase (error names the
tasks) or if another phase depends on the target. Cannot delete `_root`.

### `phase-status`

Params: `phaseId`. Returns per-phase task counts (pending/ready/in-progress/done/
skipped/blocked), frozen state, `executor` (raw), `resolvedExecutor` (cascade
applied), phase acceptance criteria, and any annotations.

### `phase-ac`

Params: `phaseId`, `criteria[]`. Appends to `phase.acceptanceCriteria`. Rejects
when the phase is frozen or when `phaseId` is `_root`.

### `phase-freeze` / `phase-unfreeze`

Params: `phaseId`. Toggles the phase-level frozen bit. Cannot freeze `_root`.

### `phase-annotate`

Params: `phaseId`, `text`, optional `category`. Rejects unknown categories.

## Actions — verification (opt-in)

### `verify`

Params: optional `reviewers` (1–10, default 4), optional `reviewerRoles[]`
(subset of `completeness`, `correctness`, `safety`, `quality`), optional
`override`, optional `reason` (required when `override: true`).
Returns: `VerifyReport` or `{ unavailable: true, reason, verdict: "unknown" }`.
Persists report to `${scratchDir}/verify/plan/<timestamp>.md`.

### `phase-verify`

Params: `phaseId` (required), otherwise identical to `verify`. Persists to
`${scratchDir}/verify/<phaseId>/<timestamp>.md`.

## Actions — introspection

### `status`

Returns the plan's rendered text with phase groupings (if any), executor badges,
divergence/blocker badges, the live spawn-budget line
(`spawns: N/M remaining · K active runs` or `spawns: probe-unavailable`), and a
Pending completions section from `scanTaggedArtifacts()`.

### `get`

Params: `taskId`, optional `verbose`. When `verbose: true`, response `details`
includes a `resolved` snapshot of the task's fields with the defaults cascade
applied.

### `diff`

Returns tasks added / removed / modified since the last saved revision.

### `reconcile`

Advisory: scans recent subagent artifacts (via the pi-subagents bridge, when
available) and returns `{ offers: [{taskId, artifactPath, subagentRunId}] }` for
matches against open tasks. Never auto-completes.

## Actions — plan lifecycle

### `list-plans` / `switch-plan` / `archive` / `unarchive` / `delete-plan`

Params vary; all read-mostly beyond `switch-plan` and `archive`. `switch-plan`
auto-unarchives if needed.

## Retired items

| Item | Status | Migration |
| --- | --- | --- |
| `add-criteria` | deprecated; stderr warning | Use `update` with `updates.acceptanceCriteria`. |
| `references.related` | silently deprecated | Move linked task IDs into task description text. |
| `expand` | deprecated alias; warns | Use `add-subtasks`. |

Retired items are removed in the next major version. Deprecation window is one
release.
