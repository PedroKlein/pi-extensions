# @pedro_klein/pi-task

## 0.3.0

### Minor Changes

- pi-task: Improve tool usability for agents with 6 new actions:

  - `add` — append tasks to existing plan (no more recreating the whole plan)
  - `start` — mark task as in-progress
  - `add-subtasks` — clearer alias for `expand`
  - `bulk-complete` / `bulk-skip` — complete/skip multiple tasks at once
  - `delete-plan` — permanently remove a plan from disk

  Also improved promptGuidelines to teach agents the full lifecycle.

  pi-memory: Add `dev` watch script.

## 0.2.0

### Minor Changes

- fb8198c: Standardize all packages for npm publishing

  Every package now follows the same canonical structure:

  - Source moved to `src/` directory (pi loads TypeScript directly)
  - All `@mariozechner/*` imports replaced with `@earendil-works/*`
  - Added `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` to each package
  - Normalized `package.json`: proper `exports`, `files: ["src"]`, `pi.extensions`, `repository`, `homepage`
  - README rewritten with structured sections (Install → What it provides → Config → How it works → Development)
  - Added unit tests to every package (531 tests total across 14 packages)
  - Fixed `pi.skills` manifest in pi-repos, `pi.prompts` manifest in pi-modes
  - Fixed pi-readonly-bash (was missing version, main, files, scripts)
  - Added `mkdir` to bash policy denylist (pi-readonly-bash bug fix)
