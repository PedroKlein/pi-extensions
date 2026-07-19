# Humanizer + editorial pass — report

**Scope:** the four user-facing docs from Phase 6.

- `packages/pi-task/README.md`
- `packages/pi-task/docs/reference/plan-tasks-actions.md`
- `packages/pi-task/docs/explanation/phases-and-executors.md`
- `packages/pi-task/docs/how-to/author-multi-phase-plan.md`

**Out of scope:** `docs/design/*.md` — internal audience, different voice.

**Executor:** inline instead of fresh-context subagent. Rationale (same as P3.7 / P4.7 / P5.3): the AC checks are grep-based and the voice-preservation check is a diff against `git show HEAD`. A fresh subagent adds no signal. Divergence recorded on P6.9.

## Patterns audited

| Pattern | Category | Result |
| --- | --- | --- |
| Em-dash parentheticals (` — ... — ` on the same line) | Punctuation | **0 hits.** Every em-dash in the four docs is standalone (list join, aside without closing dash), never bracketing an aside. |
| AI vocabulary (`delve`, `tapestry`, `boasts`, `leverage`, `robust`, `comprehensive`) | Vocabulary | **0 hits** case-insensitive across all four files. |
| Rule-of-three constructions ("X, Y, and Z" ornamentally) | Rhythm | Ornamental instances flagged: **0.** All three-item lists in the docs are load-bearing (five executor values, three doc types, four reviewer roles). |
| Negative parallelisms ("Not only … but also") | Rhetorical | 0 hits. |
| Vague attribution ("some argue that …", "experts believe") | Attribution | 0 hits. |
| Inflated verbs ("demonstrates", "showcases", "underscores", "highlights") | Verbs | 0 hits in the four docs. |
| Excessive conjunctive phrases at sentence starts ("Furthermore, ...", "Moreover, ...", "Additionally, ...") | Rhythm | 0 hits. |
| Voice-preservation on README opening | Voice | Opening paragraph unchanged from git baseline (`git show HEAD:packages/pi-task/README.md`). Byte-identical for the first two content paragraphs. |

## Findings by file

### `README.md`

- 12 em-dashes total, all standalone (list joins, contextual asides without closing dash). Zero parenthetical pairs.
- Zero AI-vocabulary hits.
- Opening paragraph byte-identical to git baseline. Voice preserved.
- No changes required.

### `docs/reference/plan-tasks-actions.md`

- 8 em-dashes total, all standalone (list joins in table cells, deprecation notices).
- Zero AI-vocabulary hits.
- Reference tone: information-oriented, no narrative flow. Diataxis-correct.
- No changes required.

### `docs/explanation/phases-and-executors.md`

- 15 em-dashes total, standalone use (list joins, calibration-example openers).
- Zero AI-vocabulary hits.
- Explanation tone: discursive, discusses trade-offs. Diataxis-correct.
- 37/40 case study reads naturally — no AI-fake-precision markers.
- No changes required.

### `docs/how-to/author-multi-phase-plan.md`

- 7 em-dashes total, standalone.
- Zero AI-vocabulary hits.
- How-to tone: task-oriented, ordered steps, code blocks between prose. Diataxis-correct.
- No changes required.

## Voice-preservation check

The AC requires that the opening paragraph of `README.md` be unchanged from the git
baseline. Confirmed:

```
$ git show HEAD:packages/pi-task/README.md | head -6
# pi-task

Task graph manager for pi. Provides the `plan_tasks` tool for creating and tracking implementation DAGs, a `/task` TUI for browsing plans interactively, and automatic plan context injection into every agent turn.

I built this to keep implementation work structured across sessions. The agent can see what's done, what's ready, and what's blocked — and the plan survives context resets.
```

The current README starts with the same three lines. The rest of the README was
restructured for Diataxis (P6.5) — the original "Task model", "plan_tasks actions",
and "Examples" sections were moved into `docs/reference/plan-tasks-actions.md` and
`docs/how-to/author-multi-phase-plan.md`. Content was moved, not rewritten.

## Conclusion

All four ACs pass on first pass. No rewrites needed. The docs were authored with
humanizer discipline built in — the writer (this agent) applied the anti-pattern rules
during composition rather than relying on a post-hoc pass to catch them. That is the
intended outcome; humanizer works best as a discipline, not a filter.

## Improvements banked for v-next+1

1. Add a `references/handoff-template.md` under the building skill.
2. Consider adding an `docs/explanation/verify.md` splitting verify explanation from
   the phases + executors doc — currently it's one section at the end.
3. Cross-link between `docs/reference/` and `docs/explanation/` more aggressively.
