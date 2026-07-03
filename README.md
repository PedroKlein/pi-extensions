# pi-extensions

Personal Pi coding agent extensions. Built for my workflow, published as
individual npm packages from a monorepo. You're welcome to use them, fork them,
or steal ideas.

## Packages

| Package | Description |
|---------|-------------|
| [`@pedro_klein/pi-auto-retry`](packages/auto-retry) | Auto-retry on malformed tool call JSON |
| [`@pedro_klein/pi-caffeinate`](packages/caffeinate) | Prevent sleep during agent work (macOS/Linux) |
| [`@pedro_klein/pi-adhd`](packages/pi-adhd) | Attention management — sticky notes, side-chat, reminders |
| [`@pedro_klein/pi-ask`](packages/pi-ask) | Interactive TUI questionnaire tool |
| [`@pedro_klein/pi-baml`](packages/pi-baml) | BAML integration for typed structured LLM output |
| [`@pedro_klein/pi-games`](packages/pi-games) | Snake & Flappy Bird while the agent works |
| [`@pedro_klein/pi-memory`](packages/pi-memory) | Persistent memory with Dream async session mining |
| [`@pedro_klein/pi-modes`](packages/pi-modes) | 5-mode system (Ask/Brainstorm/Plan/Build/None) with tool gating |
| [`@pedro_klein/pi-readonly-bash`](packages/pi-readonly-bash) | Bash policy enforcement — read-only shell for safe modes |
| [`@pedro_klein/pi-repos`](packages/pi-repos) | Repo management + orchestration layer |
| [`@pedro_klein/pi-status`](packages/pi-status) | Context bar compositor + LLM environment injection |
| [`@pedro_klein/pi-task`](packages/pi-task) | Task graph manager — DAG plans with parallel groups |
| [`@pedro_klein/pi-term`](packages/pi-term) | Floating terminal panel for TUI |
| [`@pedro_klein/pi-todo`](packages/pi-todo) | TODO board with PR review tracking |

## Install

Individual packages:

```bash
pi install npm:@pedro_klein/pi-modes
pi install npm:@pedro_klein/pi-memory
pi install npm:@pedro_klein/pi-repos
```

All extensions (local git install):

```bash
pi install https://github.com/PedroKlein/pi-extensions
```

## Package Structure

Every package follows the same canonical layout:

```
packages/<name>/
├── src/           # TypeScript source (pi loads .ts directly)
├── tests/unit/    # vitest tests
├── skills/        # optional pi skills
├── prompts/       # optional prompt templates
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

See [TEMPLATE.md](TEMPLATE.md) for the full standard.

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run all tests
pnpm typecheck      # type-check all packages
```

### Publishing

Uses [changesets](https://github.com/changesets/changesets) for versioning:

```bash
pnpm changeset      # describe what changed
# push to main → GH Action opens "Version Packages" PR
# merge that PR → packages are published to npm
```

### Local Development

To use local extensions during development:

```json
{
  "packages": ["/path/to/pi-extensions"]
}
```

## License

MIT
