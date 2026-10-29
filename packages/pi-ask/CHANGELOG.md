# @pedro_klein/pi-ask

## 0.3.0

### Minor Changes

- d7397fe: Add `e` to explain the current question using conversation background in a separate view. Clarification follow-ups stay in memory and out of the main conversation, while selections and existing option explanations remain unchanged.

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
  - Fixed pi-readonly-bash (was missing version, main, files, scripts)
  - Added `mkdir` to bash policy denylist (pi-readonly-bash bug fix)
