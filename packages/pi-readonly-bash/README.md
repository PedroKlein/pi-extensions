# pi-readonly-bash

Extension providing a `bash_readonly` tool — a drop-in inspection-only alternative to the built-in `bash` tool.

Uses pi's `createBashTool` for identical execution behavior (output truncation, streaming, timeout, process tree management), wrapped with a validation gate that blocks mutating commands before execution.

## How It Works

Every `bash_readonly` call is validated against a denylist-based policy before execution. Blocked commands return an error immediately without spawning a process. Allowed commands execute identically to the built-in `bash` tool.

The policy uses two layers:
1. **Structural rules** — blocks redirects (`>`), heredocs (`<<`), process substitution, backticks, `eval`, `tee`, `xargs`, `sed`
2. **Command denylist** — blocks known-destructive commands (`rm`, `mv`, `cp`, `mkdir`, `chmod`, etc.) and mutating subcommands of safe commands (`git commit`, `npm install`, `docker run`, etc.)

## What's Allowed

Inspection and non-destructive commands:
- File reading: `cat`, `head`, `tail`, `less`, `file`, `stat`, `wc`
- Search: `grep`, `find`, `ls`, `tree`, `du`, `df`
- Git (read-only): `git status`, `git diff`, `git log`, `git show`, `git branch -a`
- Build/test: `npm test`, `npm run`, `npm build`, `go test`, `go build`, `go run`, `cargo test`, `cargo build`, `cargo run`
- Network (GET only): `curl` (without `-X`/`-d`/`-o` flags)
- Data processing: `jq`, `sort`, `uniq`, `diff`, `comm`, `cut`, `tr`
- Environment: `env`, `echo`, `printf`, `which`, `type`, `node -e`, `python -c`

## What's Blocked

- **Filesystem mutation**: `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `ln`
- **File content mutation**: `sed`, `awk`, `perl`, `patch`, `ed`
- **Output redirection**: `>`, `>>` (except `2>/dev/null` and `2>&1`)
- **Shell features**: heredocs, backticks, `$(...)`, `eval`, `source`
- **Package managers (mutating)**: `npm install`, `pip install`, `go get`, `cargo install`, `brew install`
- **Git (mutating)**: `git commit`, `git push`, `git merge`, `git rebase`, `git checkout`
- **Infrastructure**: `docker run`, `kubectl apply`, `terraform apply`, `ansible`
- **System**: `sudo`, `kill`, `reboot`, `crontab`, `mount`

Full rules are in `bash-policy-rules.ts` (declarative data, easy to scan and extend).

## Usage

### As an extension (always-on)

Place in `~/.pi/agent/extensions/pi-readonly-bash/` — it auto-loads and registers `bash_readonly`.

Use with pi-modes: pi-modes denies `bash` in ask/brainstorm/plan modes (replaced by `bash_readonly`) and allows full `bash` in build/none modes.

### With subagents

Subagent children load all global extensions automatically. The `tools` override in `settings.json` controls which tools each agent can use:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "tools": ["read", "grep", "find", "ls", "bash_readonly"]
      },
      "worker": {
        "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"]
      }
    }
  }
}
```

Scout gets `bash_readonly` (readonly enforcement). Worker gets `bash` (full access).

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry — registers `bash_readonly` tool using `createBashTool` + validation gate |
| `bash-policy.ts` | Validation engine — parser, tokenizer, structural rules, subcommand checks |
| `bash-policy-rules.ts` | Declarative rules — denied commands, subcommand policies, flag checks |
| `package.json` | Pi package manifest |
