# pi-extensions

Personal Pi coding agent extensions — published as individual npm packages from a monorepo.

## Packages

| Package | Description |
|---------|-------------|
| [`@pedroklein/pi-auto-retry`](packages/auto-retry) | Auto-retry on malformed tool calls |
| [`@pedroklein/pi-caffeinate`](packages/caffeinate) | Prevent macOS sleep during agent work |
| [`@pedroklein/pi-adhd`](packages/pi-adhd) | Attention management — sticky notes, side-chat, reminders |
| [`@pedroklein/pi-ask`](packages/pi-ask) | Interactive TUI questionnaire |
| [`@pedroklein/pi-baml`](packages/pi-baml) | BAML integration for typed structured LLM output |
| [`@pedroklein/pi-games`](packages/pi-games) | Play games while the agent runs |
| [`@pedroklein/pi-memory`](packages/pi-memory) | Persistent memory with Dream async session mining |
| [`@pedroklein/pi-modes`](packages/pi-modes) | 5-mode system (Ask/Brainstorm/Plan/Build/None) with tool gating |
| [`@pedroklein/pi-readonly-bash`](packages/pi-readonly-bash) | Bash policy enforcement in read-only modes |
| [`@pedroklein/pi-repos`](packages/pi-repos) | Repo management + orchestration layer |
| [`@pedroklein/pi-status`](packages/pi-status) | Context bar compositor + LLM environment injection |
| [`@pedroklein/pi-task`](packages/pi-task) | Task graph manager — DAG plans with parallel groups |
| [`@pedroklein/pi-term`](packages/pi-term) | Floating terminal for TUI apps |
| [`@pedroklein/pi-todo`](packages/pi-todo) | TODO board with PR review tracking |

## Install

Individual packages:

```bash
pi install npm:@pedroklein/pi-repos
pi install npm:@pedroklein/pi-memory
```

All extensions (git install):

```bash
pi install git:github.com/PedroKlein/pi-extensions
```

## Development

```bash
pnpm install
pnpm build          # build all packages
```

### Publishing

Uses [changesets](https://github.com/changesets/changesets) for versioning:

```bash
pnpm changeset      # describe what changed
# push to main → GH Action opens "Version Packages" PR
# merge that PR → packages are published to npm
```

## Local Development

To use local extensions during development, add to your Pi settings:

```json
{
  "packages": ["/path/to/pi-extensions"]
}
```

## License

MIT
