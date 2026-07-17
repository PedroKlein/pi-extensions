# pi-handoff

Structured context transfer between Pi sessions. Produce a handoff when ending a session; pick it up in a fresh one.

## Install

```bash
pi install npm:@pedro_klein/pi-handoff
```

## Commands

### /handoff [goal]

Generates a handoff document for the next session.

The extension gathers context automatically (git state, active plan if available, recent commits). Then the agent produces a forward-looking handoff document, guided by the `handoff` skill. The document is written to disk and a pickup message is copied to the clipboard.

**With a goal:**
```
/handoff implement phase 5 plugins
/handoff continue the auth discussion from where we left off
/handoff plan the evaluation infrastructure
```

**Without a goal:**
```
/handoff
```
The agent infers the goal from session context or asks.

### /pickup [repo-slug]

Loads the latest handoff for the current repo, injects it into the conversation, and archives the file.

```
/pickup              # loads handoff for current repo
/pickup wafer-poc    # cross-repo: loads from PedroKlein-wafer-poc
```

After pickup, the handoff file moves to `archive/` and cannot be picked up again.

## File Structure

```
~/.pi/handoffs/
  PedroKlein-wafer-poc/
    latest.md                    # current pending handoff
    archive/
      2026-07-16T22-30-00-000Z.md  # consumed handoffs
  PedroKlein-pi-extensions/
    latest.md
    archive/
```

Repo slugs are derived from `git remote get-url origin`. SSH and HTTPS formats both resolve to `owner-repo`. Falls back to directory name when no remote exists.

## Skill

The extension ships a `handoff` skill that teaches the agent what makes a good handoff document. The skill covers:

- Forward-looking principles (what the receiver needs, not what the sender did)
- Different handoff types (discussion, plan-to-build, build-to-build, research chain)
- The non-duplication rule (reference files by path, never copy their content)
- When to ask the user vs infer from context
- Anti-patterns that produce bad handoffs

The skill is auto-discovered when pi-handoff is installed.

## Design Decisions

**Explicit trigger.** Handoffs happen when you decide, not automatically. `/handoff` is intentional; the agent doesn't guess when you're done.

**Consume-once.** `/pickup` archives the file. A handoff is a disposable transfer document, not a permanent record. Old handoffs live in `archive/` for reference but won't re-inject.

**Forward-looking, not retrospective.** The handoff answers "what does the next session need?" not "what did this session do?" Content is selected by what accelerates a cold start on the stated goal.

**No duplication.** Plans, ADRs, decision docs, and code exist in files. The handoff references them by path. Only decisions that live solely in the conversation get written into the handoff.

**Skill-guided, not template-driven.** Different handoff types need different content. The skill teaches principles; the agent decides what to include based on the goal.

**Cross-repo pickup.** Pass a repo slug to `/pickup` to load a handoff written in a different repo's session. Handles the "I discussed this in repo A, now building in repo B" case.

## License

MIT
