# pi-focus

Persistent semantic focus and execution telemetry for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-focus` keeps a small panel below the editor so you can see what the agent is trying to accomplish, what it is doing now, and whether a long-running tool still appears active.

## Install

```bash
pi install npm:@pedro_klein/pi-focus
```

## What it shows

Normal work uses a separate line for each semantic level:

```text
▌ FOCUS  Add incremental repository sync                 ACTIVE
▌ NOW    Fixing cache invalidation
▌ NEXT   Resume index tests
```

An active tool adds one temporary line:

```text
▌ RUN    integration tests · 6m12s · expected 2–4h · output 18s ago
```

The themed rails distinguish Goal, Now, Next, and execution telemetry with separate colors. `NEXT` appears only when Then is declared, and active execution adds one `RUN` line. After the agent settles, `NOW` becomes `LAST`; waiting, blocked, and completed work use `WAIT`, `BLOCK`, and `DONE`.

## Semantic focus

The agent publishes focus explicitly through `focus_update`. The extension does not derive Goal, Now, or Then from conversation text, tool arguments, or a secondary model.

| Field | Meaning |
|---|---|
| `goal` | Overall outcome. Required on the first update. |
| `now` | Current public activity. |
| `then` | Where work should return next. |
| `state` | `active`, `waiting`, `blocked`, or `done`. |
| `expected_duration` | Optional duration such as `45m`, `3h`, `2d`, or `1.5w`. |
| `handoff` | One concise recommendation for the next session. |

Supported duration units are seconds (`s`), minutes (`m`), hours (`h`), days (`d`), weeks (`w`), months (`mo`), and years (`y`). Durations are stored as normalized milliseconds and displayed as coarse ranges. Ranges cover seconds through months and continue with generated year ranges such as `1–2y`, `2–4y`, and `4–8y`; there is no fixed duration-category ceiling.

The agent is instructed to update focus when it establishes a goal, takes a detour, starts expected-long work, waits or becomes blocked, returns from a detour, completes work, or hands work off.

## Commands

- `/focus` — show the current snapshot and recent semantic transitions.
- `/focus edit` — edit the snapshot with Pi's native editor.
- `/focus clear` — clear the displayed focus after confirmation.

The agent can update or complete focus but cannot clear it.

## Long-running tools

`pi-focus` tracks top-level tool lifecycle events. It displays elapsed time and time since the latest partial output without retaining command output. Concurrent work is reduced to one line: possibly stalled work first, then declared-long work, then the longest-running tool, followed by `+N other tools`. Subagents are shown only as a top-level aggregate.

Possible-stall detection is deliberately conservative. It requires both:

```text
elapsed >= max(2 minutes, expected duration × 2)
output silence >= clamp(expected duration ÷ 6, 30 seconds, 24 hours)
```

A possible stall produces one warning. `pi-focus` never terminates, retries, or aborts the operation.

## Resume and freshness

Semantic transitions are stored as Pi custom session entries, so `/resume`, `/tree`, and forks reconstruct state from their active branch. Resuming unfinished work shows one brief card with the goal, stopping point, intended next step, update time, and any interrupted declared-long operation.

Active semantic focus is marked `possibly stale` after three completed turns or ten completed non-focus tools without a `focus_update`. The next turn receives one hidden reminder to refresh or reaffirm the public status. The extension never invents replacement text.

## Privacy

Raw tool arguments, shell commands, partial output, and child-agent transcripts are neither displayed nor persisted. Routine tool telemetry is ephemeral. Persistence is limited to semantic transitions, declared-long execution boundaries, and exceptional waiting, stall, failure, or abort events.

## V1 limits

`pi-focus` does not provide automatic summarization, a task graph, verification claims, automatic retries or termination, full shell history, a child-agent dashboard, configurable stall formulas, or automatic session creation. A `done` state reports the agent's status; it is not proof that independent verification passed.

## Development

```bash
pnpm --filter @pedro_klein/pi-focus test
pnpm --filter @pedro_klein/pi-focus typecheck
pnpm --filter @pedro_klein/pi-focus build
```

## License

MIT
