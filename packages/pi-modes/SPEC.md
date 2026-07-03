# pi-modes + pi-status — Design Spec

> Decided: 2026-06-22 (brainstorm session)
> Replaces: workflow-modes extension (~2656 lines → ~400-500 lines total)

## Overview

Split the monolithic `workflow-modes` extension into two focused extensions:

1. **pi-modes** — Mode enforcement, prompts, switching, build scope negotiation
2. **pi-status** — Context bar UI, footer, title, LLM environment injection

## pi-modes (~200-300 lines)

### Core Responsibilities

| Concern | Implementation |
|---------|---------------|
| Tool gating | Denylist: deny `bash` in ask/brainstorm/plan (replaced by `bash_readonly`), deny mutating subagents in ask/brainstorm/plan. Build + none = unrestricted. |
| Write filtering | ask/brainstorm: allow .md/.mdx in cwd, /tmp/, ~/.pi/. Block all other writes. No filtering in plan/build/none. |
| Mode prompts | Single concise prompt per mode (15-20 lines). Injected via `before_agent_start`. NONE injects nothing. |
| Mode switching | Ctrl+Alt+M cycle (ask→brainstorm→plan→build→none→ask). No slash commands — avoids conflicts with babysitter. Mode also switchable via `pi-ask:mode-switch` event (from ask_user actions). |
| Build scope negotiation | Programmatic `ctx.ui.select` on first build turn. Generic options. Not triggered in none. |
| Mode persistence | `appendEntry` to survive session reloads. |
| Events | Emits `pi-modes:changed` with `{ mode, previousMode }`. Listens to `pi-ask:mode-switch`. |

### Modes Summary

| Mode | Icon | Tools | Prompt | Purpose |
|------|------|-------|--------|---------|
| **Ask** | ❓ | bash_readonly, no mutating subagents | ~14 lines | Investigation, diagnosis, evidence gathering |
| **Brainstorm** | 💡 | bash_readonly, no mutating subagents | ~18 lines | Active thinking partner, challenges, trade-offs |
| **Plan** | 📋 | bash_readonly, no mutating subagents | ~16 lines | Task graph structuring, TDD breakdown |
| **Build** | 🔨 | ALL tools | ~20 lines | Implementation, verification, reporting |
| **None** | ⊘ | ALL tools | 0 lines | Raw Pi. No constraints from pi-modes. |

### What's NOT in pi-modes

- ❌ Nudges (all 13 types removed)
- ❌ BAML intent classification
- ❌ Verification tracker
- ❌ Decision log / appendDecision
- ❌ Retrospect / handoff commands
- ❌ Block tracker / anti-thrash
- ❌ Stats cache
- ❌ Scope tracking / auto-complete tasks
- ❌ Plan coupling (no imports from pi-task-lib)
- ❌ Mode overview injection
- ❌ SKILL_LOADING_INSTRUCTION (moves to settings.json)
- ❌ Worktree context (moves to pi-status)
- ❌ Boundary messages in conversation history
- ❌ Bash command safety (guardrails' job)

### Tool Gating Strategy: Denylist

```
NONE mode:     ALL tools available, zero mode prompt injection. Raw Pi.
Build mode:    ALL tools available (no restrictions)
Plan mode:     deny bash (has bash_readonly). Everything else allowed.
Ask mode:      deny bash (has bash_readonly). Everything else allowed.
Brainstorm:    deny bash (has bash_readonly). Everything else allowed.
```

Additional enforcement:
- Subagent gating: worker + oracle-executor blocked in ask/brainstorm/plan only
- Write filtering: ask/brainstorm block non-markdown writes outside /tmp and ~/.pi
- plan_tasks: allowed in ALL modes (reading tasks is harmless)
- NONE: no write filtering, no subagent gating, no prompt injection

New tools from new extensions are auto-available in all modes (denylist benefit).

### Build Scope Negotiation

On first turn in build mode, before the agent starts:
```
ctx.ui.select("Build scope:", ["One task", "Multiple tasks", "Until I hit a problem"])
ctx.ui.select("Handoff format:", ["Markdown in chat", "HTML report", "None"])
```

Result injected into system prompt: `"Scope: one task. Handoff: markdown."`
Generic — no plan/task-specific language. Works with or without pi-task.

Not triggered in none mode (none has zero prompt injection).

### Mode Boundary Behavior

- NO message injection into conversation history on mode switch
- System prompt change is sufficient (agent sees new prompt next turn)
- UI notification only: "Switched to build mode"
- The `pi-modes:changed` event notifies other extensions (pi-status updates bar)

---

## pi-status (~150-200 lines)

### Core Responsibilities

| Concern | Implementation |
|---------|---------------|
| Context bar | Renders all segments (built-in + external) as the `context-bar` widget |
| Built-in segments | Mode icon/label, model name, token bar + %, I/O tokens, cost, thinking level, git branch |
| External segments | Registration via `pi-status:register` / `pi-status:update` events |
| LLM env injection | Small block in system prompt: git branch, worktree warning, context % |
| Footer | CWD, keyboard shortcut hints |
| Title | `pi - 🔨 build - 4.6 Opus - main` |

### Event Protocol

```typescript
// Register a segment
pi.events.emit("pi-status:register", {
  id: "mode",           // unique ID
  priority: 100,        // higher = further left
  render: (theme) => theme.fg("success", "🔨 BUILD"),
});

// Update a segment
pi.events.emit("pi-status:update", {
  id: "mode",
  render: (theme) => theme.fg("warning", "💡 BRAINSTORM"),
});

// Remove a segment
pi.events.emit("pi-status:update", { id: "mode", render: null });
```

### LLM Environment Injection

Injected into system prompt via `before_agent_start` (~30-40 tokens):

```
Git branch: main
Context: 47% used (94k/200k tokens)
⚠ 3 worktrees active — verify correct worktree before making changes.
```

Worktree warning only appears when multiple worktrees detected.

---

## Mode Prompts

### NONE (0 lines — no injection)

No prompt injected. Pi's base system prompt + project context + skills only.
The agent operates without any behavioral constraints from pi-modes.
Use for: babysitter-driven workflows, ad-hoc tasks, raw agent access.

### ASK (~14 lines)

```markdown
[MODE: ASK - Discovery & diagnosis (read-only)]

Rules:
- Read-only. Writes limited to markdown (.md/.mdx) in cwd, /tmp/, ~/.pi/.
- Help the user understand, debug, or investigate. Evidence-first.
- Lead with a TL;DR, then supporting details.
- Gather evidence aggressively: read code, run inspection commands, search.
- For yes/no or A-vs-B decisions, use ask_user (not prose questions).
- Don't drift into brainstorming or option-comparison. Suggest /brainstorm for that.
- When you have code to share, show it inline. Tell the user to /build to apply.

Mode flow:
- Implementation intent → suggest /build
- Comparing options → suggest /brainstorm
- Large/risky change → suggest /plan then /build
```

### BRAINSTORM (~18 lines)

```markdown
[MODE: BRAINSTORM - Thinking partner (read-only)]

Rules:
- Read-only. Writes limited to markdown (.md/.mdx) in cwd, /tmp/, ~/.pi/.
- You are a brainstorming partner. Think alongside the user — question assumptions,
  surface trade-offs, explore alternatives, challenge weak reasoning.
- Ask targeted questions. Don't monologue. Drive toward decisions.
- Use ask_user for concrete choices (A vs B, yes/no, pick from options).
- Present approaches briefly (bullets, not essays). Show concrete shapes — types,
  directory trees, call sites — not abstract descriptions.
- Always include the simplest-viable path. Only recommend complex when simple fails.
- When you have code to share, show it inline. Tell the user to /build to apply.

Mode flow:
- Small clear scope → suggest /build
- Large/risky scope → suggest /plan
- High uncertainty → suggest /grill
```

### PLAN (~16 lines)

```markdown
[MODE: PLAN - Task graph planner]

Rules:
- Read-only bash. Use edit/write only for plan files and markdown.
- Use plan_tasks tool to create and manage task graphs.
- Tasks form a two-level hierarchy: feature tasks with TDD-sized sub-tasks.
- Each task needs: id, title, description, dependencies, expected files, tddNotes.
- Fill in files field for scope tracking. Set parallelGroup for independent tasks.
- For yes/no or A-vs-B decisions, use ask_user.
- Ask "how far should I go?" before suggesting /build.

Plan contract:
1. Plan overview (goal, scope, approach)
2. Task graph with dependencies
3. Per-task TDD notes
4. Open questions / assumptions
```

### BUILD (~20 lines)

```markdown
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
```

---

## Babysitter Integration

### Installation

```bash
pi install npm:@a5c-ai/babysitter-pi
```

No global SDK install needed — the babysitter skill uses `npx -y @a5c-ai/babysitter-sdk@$VERSION` to run CLI commands on demand. Pi remembers the package in settings.json; no setup script changes required.

Verify: `npx -y @a5c-ai/babysitter-sdk harness:discover --json`

### How it works with pi-modes

- Babysitter is a skill + CLI tool. Its Pi plugin registers slash commands (`/call`, `/babysitter:yolo`, `/babysitter:plan`, etc.) that invoke skills.
- Skills tell the agent to run `babysitter` CLI commands via bash.
- Orchestration commands (`run:create`, `run:iterate`, `task:post`) are mutating → require build or none mode.
- **Recommended workflow:** cycle to none mode, then `/call` — babysitter defines its own constraints via process code, pi-modes stays out of the way entirely.
- Babysitter and pi-task are complementary: babysitter for cross-session orchestration with enforcement, pi-task for intra-session lightweight planning.

### Configuration

No special pi-modes configuration needed. Babysitter works with Pi's standard skill + extension system.

Note: Babysitter registers its own `/plan` and `/yolo` commands. Since pi-modes uses only Ctrl+Alt+M for cycling (no slash commands), there are zero conflicts.

---

## Settings Changes

1. Move `SKILL_LOADING_INSTRUCTION` to settings.json (appendSystemPrompt or equivalent)
2. Load `pi-modes` + `pi-status` in extensions list
3. Add `@a5c-ai/babysitter-pi` to packages
4. Disable `workflow-modes` (keep as reference)
5. No changes to guardrails config (handles bash safety independently)

## Migration Plan

1. Create `pi-modes/` and `pi-status/` as new extensions
2. Test both independently
3. Install babysitter-pi package
4. Disable `workflow-modes` via settings (keep files)
5. Update settings.json to load new extensions
6. Resolve any command name conflicts (babysitter /plan vs pi-modes /plan)
7. Remove `workflow-modes` once confident

## Context Budget (per turn)

| Component | Before | After (build) | After (none) |
|-----------|--------|---------------|--------------|
| Mode overview | ~80 tokens | 0 | 0 |
| Mode prompt | 300-700 tokens | 150-200 tokens | 0 |
| SKILL_LOADING_INSTRUCTION | ~60 tokens | 0 | 0 |
| Worktree context | ~30 tokens | ~30 tokens (pi-status) | ~30 tokens (pi-status) |
| Scope tracking | 50-100 tokens | 0 | 0 |
| Build scope result | ~80 tokens | ~40 tokens | 0 |
| Env block (new) | 0 | ~30 tokens | ~30 tokens |
| **Total extension injection** | **600-1100** | **220-280** | **~30** |

**Build mode reduction: 60-75%. Yolo mode: ~97% reduction (only pi-status env block).**

---

## Not In Scope (handled elsewhere)

- Bash command safety → guardrails extension (autoDenyPatterns, permissionGate)
- Plan/task management → pi-task extension
- Verification tracking → removed (prompt says "run tests/lint", trust the agent)
- Session retrospect → removed entirely
- Handoff snapshots → removed entirely
- Decision logging → removed entirely
