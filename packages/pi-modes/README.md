# pi-modes

A five-mode workflow system for Pi. Each mode combines a short, stable behavioral contract with extension-level tool enforcement.

## Install

```bash
pi install npm:@pedro_klein/pi-modes
```

Also install [`@pedro_klein/pi-readonly-bash`](https://github.com/PedroKlein/pi-extensions/tree/main/packages/pi-readonly-bash). Read-only modes replace `bash` with `bash_readonly`.

## Controls

- `/ask`, `/brainstorm`, `/plan`, `/build`, `/none` switch mode without starting a model turn.
- `Ctrl+Alt+M` cycles Ask → Brainstorm → Plan → Build → None → Ask.
- `pi-ask:mode-switch` switches mode from an in-run `ask_user` action, aborts the old run, and queues one attributed continuation.

The extension emits `pi-modes:changed` with `{ mode, previousMode }` and publishes its status segment through `pi-status:register`.

## Modes

| Mode | Access | Purpose |
|---|---|---|
| Ask | Read-only | Investigation, diagnosis, explanation |
| Brainstorm | Read-only | Alternatives, trade-offs, decisions |
| Plan | Read-only | Verifiable implementation planning |
| Build | Full | Implementation and verification |
| None | Unmodified | Raw Pi with no prompt or tool changes from pi-modes |

## Enforcement

In Ask, Brainstorm, and Plan:

- `bash` is replaced by `bash_readonly`.
- Mutating worker agents are blocked.

Ask and Brainstorm additionally restrict file mutation to Markdown inside the project, temporary files, and `~/.pi/` state.

Build enables the full catalog except the redundant read-only Bash wrapper. None preserves the complete tool catalog exactly as registered.

## Mode contracts

The four contracts under `prompts/` contain only purpose, boundaries, and completion behavior. They are loaded relative to the installed package and injected as stable system-prompt suffixes. They are package internals, not global Pi prompt templates. None injects nothing.

Mode switches do not open scope dialogs or add transient prompt text. The next ordinary turn receives the new stable contract.

## Persistence

Mode state is stored as a non-model-visible `pi-mode` session entry and restored on reload. New sessions default to Ask.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT
