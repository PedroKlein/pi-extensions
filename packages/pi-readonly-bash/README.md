# pi-readonly-bash

Provides a `bash_readonly` tool that enforces a read-only policy — allows inspection commands (`ls`, `cat`, `grep`, `find`) but blocks anything that mutates state (`rm`, `mv`, redirects, pipes to files).

I built this for use with pi-modes, where Ask and Brainstorm modes should let the agent inspect code without risking accidental changes.

## Install

```bash
pi install npm:@pedro_klein/pi-readonly-bash
```

## What it provides

- **Tools:** `bash_readonly` — executes shell commands after policy validation

## How it works

The extension registers a `bash_readonly` tool. When the LLM calls it:

1. The command string is passed through the policy classifier
2. If the command is safe, it runs via pi's built-in bash executor (identical behavior to the `bash` tool)
3. If blocked, it returns an error explaining why — without executing anything

**Allowed** (read-only inspection):
- File inspection: `ls`, `cat`, `head`, `tail`, `wc`, `find`, `grep`, `rg`, `fd`
- Git read: `git log`, `git status`, `git diff`, `git show`, `git branch -a`
- Build/test: `npm run`, `npm test`, `go test`, `go build`, `cargo test`, `cargo build`
- Network read: `curl` (GET only — no `-d`, `-X`, `-o`)
- Pipes between allowed commands

**Blocked** (mutating or dangerous):
- Filesystem: `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `ln`
- Content mutation: `sed`, `awk`, `perl`, `patch`
- Redirects: `>`, `>>`, `tee`
- Execution: `eval`, backticks, `$()` command substitution
- Package installs: `npm install`, `pip install`, `brew install`
- Shell wrappers: `bash -c`, `sh -c`
- Privilege: `sudo`, `su`

The policy is a denylist — known-dangerous patterns are blocked; everything
else is allowed. Structural rules (no redirects, no heredocs, no command
substitution) act as the safety net for novel mutations.

## Configuration

No configuration required. The policy rules are built-in.

To customize allowed/blocked patterns, modify `src/bash-policy-rules.ts` and
rebuild.

## Development

```bash
pnpm test           # run tests
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## License

MIT
