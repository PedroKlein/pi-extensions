# pi-modes — Current Design

## Purpose

`pi-modes` provides five explicit operating modes without owning task management, verification, context telemetry, or status rendering. Enforcement stays in the extension; behavioral guidance stays in one stable contract per active mode.

## Mode model

| Mode | Prompt contract | Tool behavior |
|---|---|---|
| Ask | Purpose, boundaries, completion | Read-only Bash; Markdown-only project writes; no mutating workers |
| Brainstorm | Purpose, boundaries, completion | Read-only Bash; Markdown-only project writes; no mutating workers |
| Plan | Purpose, boundaries, completion | Read-only Bash; no mutating workers |
| Build | Purpose, boundaries, completion | Full catalog except redundant `bash_readonly` |
| None | No injection | Registered catalog unchanged |

The denylist model keeps new tools available automatically. None is the raw-Pi escape hatch: no contract, write filter, worker gate, or active-tool rewrite.

## Switching

Five extension commands switch state without triggering a model turn:

- `/ask`
- `/brainstorm`
- `/plan`
- `/build`
- `/none`

`Ctrl+Alt+M` cycles through the same order. Every switch persists a non-model-visible `pi-mode` entry, updates tool gating and UI state, and emits `pi-modes:changed`.

An in-run `pi-ask:mode-switch` event is different: it aborts the old run and queues one follow-up continuation after the state change. Completion usage is emitted as `pi-audit:usage` with source `pi-modes`, operation `mode-switch-continuation`, and automatic provenance.

## Prompt ownership

Contracts live under `prompts/` and are resolved from `import.meta.url`. They are bundled package resources but are not registered in `pi.prompts`, so names such as `/build` cannot expand into prompt text.

A contract contains only:

- purpose
- boundaries
- completion behavior

Mode entry adds no dialog result, context telemetry, current plan state, or other mutable text. Consecutive turns in one mode therefore receive the same suffix. None returns no system-prompt mutation.

## Tool enforcement

Ask, Brainstorm, and Plan replace `bash` with `bash_readonly` and block mutating worker agents. Ask and Brainstorm permit project writes only to Markdown; temporary paths and `~/.pi/` remain available for planning artifacts and extension state.

Build removes only the redundant `bash_readonly` wrapper. None passes every registered tool name to Pi unchanged.

## Boundaries

`pi-modes` does not own:

- scope negotiation or handoff selection
- plan/task storage
- verification orchestration
- context or cache telemetry
- status-bar composition
- generic Bash safety
- skill selection methodology

Those concerns remain with their dedicated extensions or the active workflow.

## Integration events

Emitted:

- `pi-modes:changed` — `{ mode, previousMode }`
- `pi-status:register` — mode status segment
- `pi-audit:usage` — completed synthetic-continuation usage

Consumed:

- `pi-ask:mode-switch` — in-run mode-switch request

## Session lifecycle

On `session_start`, the last valid `pi-mode` entry is restored; otherwise Ask is selected. Persistence entries are filtered from model context. Subagent child processes skip the extension to avoid inheriting parent UI and gating state.
