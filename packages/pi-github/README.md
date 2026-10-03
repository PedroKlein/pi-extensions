# pi-github

Structured GitHub checks, pull requests, issues, and explicitly authorized delivery workflows for Pi.

## Install

```bash
pi install npm:@pedro_klein/pi-github
```

The extension requires Git, the GitHub CLI (`gh`), and an authenticated account for the remote host. It supports GitHub.com and GitHub Enterprise remotes. Authentication is selected by hostname; inherited token variables are removed before `gh` reads its configured account so an invalid environment token cannot shadow a valid keyring login.

## Tools

### `github_checks`

Directly available to the model.

| Action | Required | Behavior |
|---|---|---|
| `status` | `sha` | Returns bounded check state for the exact 40-character commit SHA. |
| `wait` | `sha`; optional `timeoutMs`, `allowNoChecks` | Waits without Bash sleep loops. Progress uses replaceable `onUpdate` snapshots; only the final bounded result enters durable context. |
| `diagnose` | `sha` | Returns failed jobs, steps, annotations, attempt identity, and bounded redacted log evidence. |

Zero discovered checks is `no-checks`, not success, unless explicitly allowed. Waiting never streams raw logs.

### `github_pr`

Deferred under the `github` codemode namespace. Supports `list`, `get`, `create`, `update`, `comment`, and `review`. Read results include exact head/base SHAs, reviews, checks, mergeability, and URLs. Remote text is delimited as untrusted content.

Formal reviews of existing PRs show the exact body and require interactive confirmation. Extension-owned PRs cannot be self-approved or receive self-requested changes.

### `github_issue`

Deferred under the `github` codemode namespace. Supports `list`, `get`, `create`, `update`, `comment`, and `close`. Read results include labels, assignees, bounded comments, and URLs.

Autonomous mode may create and manage internally owned issues. Every mutation of an existing issue requires interactive confirmation.

### `github_ship`

Available to the model only while autonomous authority is active.

- `publish` requires a clean worktree, local commits, and local verification bound to the exact current HEAD SHA. It creates or adopts an eligible non-default branch, performs a fast-forward-only push, and creates or updates one ready PR.
- `merge` waits for the current PR head, reevaluates externally changed heads, and merges with `--match-head-commit`. Review-blocked PRs use GitHub auto-merge when available; otherwise the result is `awaiting-review`.

The tool never stages files, creates commits, force-pushes, pushes the default branch, modifies local branches during cleanup, self-approves, dismisses reviews, or uses administrative bypass.

## Authority

Run `/github-autonomy` interactively to select:

- `read-only`, `collaboration`, or `autonomous` mode;
- merge, squash, or rebase for autonomous merges;
- whether no discovered checks may pass;
- whether optional failed checks block merging;
- branch creation or eligible current-branch adoption;
- whether to delete owned remote branches after merge (default: yes).

Use `/github-autonomy status` to inspect the current grant and `/github-autonomy revoke` to revoke it and cancel active GitHub work. Authority is bound to the session ID, remote host, repository, and selected login. It survives reloads and resumes of that same session until revoked, and never transfers to another session.

The status bar displays `GH ✎` for collaboration authority, `GH 🚀` for autonomous authority, and `GH 🚀 n/m` while checks are active.

## Ownership and confirmation

Owned branches, PRs, and issues are recorded only in hidden Pi session entries. Branch names, commits, PRs, issues, labels, reviews, and comments receive no ownership marker.

Autonomy applies only to internally owned resources. Mutations of existing PRs or issues remain confirmation-gated per action, with the exact outbound content shown before execution. Ambiguous network outcomes are reconciled against GitHub before another mutation is attempted.

## Safety model

This package is a workflow guardrail, not an operating-system credential sandbox. It uses typed operations, session grants, ownership checks, confirmation prompts, and blocking of obvious model-issued `git push` and mutating `gh` commands. It does not prevent deliberate credential or network bypass by arbitrary local code.

The existing global `pi-guardrails` push denial remains unchanged. Only `github_ship` performs an authorized push, and only to its owned or explicitly adopted branch.

## Development

```bash
pnpm --filter @pedro_klein/pi-github test
pnpm --filter @pedro_klein/pi-github typecheck
pnpm --filter @pedro_klein/pi-github build
```
