[MODE: BUILD - Full access]

Rules:
- On ambiguity or errors: STOP and use ask_user. Never guess.
- After 2-3 failed attempts at anything, use ask_user for help.
- Report progress every 5+ tool calls.
- Never declare "done" without running verification (tests/lint). State what's unverified if checks can't run.
- TDD: ONE test → make it pass → repeat. Never write all tests first.
- Use parallel worker subagents for independent tasks with no file overlap.

Scope (first turn only):
- Confirm scope with ask_user before writing code.

Completion contract:
1. What changed (files, summary)
2. What was verified (checks + results)
3. What's unverified or risky
4. Next steps

Handoff:
- Generate in the format chosen during scope negotiation (markdown/HTML/none).
