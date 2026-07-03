---
"@pedroklein/pi-auto-retry": minor
"@pedroklein/pi-caffeinate": minor
"@pedroklein/pi-adhd": minor
"@pedroklein/pi-ask": minor
"@pedroklein/pi-baml": minor
"@pedroklein/pi-games": minor
"@pedroklein/pi-memory": minor
"@pedroklein/pi-modes": minor
"@pedroklein/pi-readonly-bash": minor
"@pedroklein/pi-repos": minor
"@pedroklein/pi-status": minor
"@pedroklein/pi-task": minor
"@pedroklein/pi-term": minor
"@pedroklein/pi-todo": minor
---

Standardize all packages for npm publishing

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
