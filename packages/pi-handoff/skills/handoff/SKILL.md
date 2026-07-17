---
name: handoff
description: >
  Produce structured session handoffs that let a fresh session cold-start on a goal
  without discovery overhead. Use when ending a session, switching contexts, handing off
  between plan and build, continuing a discussion chain, or any time the user says
  "handoff", "next session", "give me the prompt", "wrap up", "/handoff". Do NOT use
  for persisting long-term knowledge (use memory), documenting architecture (use ADRs),
  or summarizing sessions (handoffs are forward-looking, not retrospective).
---

# Handoff: Forward-Looking Context Transfer

A handoff is a map for the receiver, not a journal of the sender.
The question is never "what happened?" but "what does the next session need to start fast?"

## Core Principle

Everything in the handoff must pass one test: **would removing this make the next session slower to start?** If removing a section wouldn't change the receiver's first 5 minutes, delete it.

## What to Think About

Before writing, identify the handoff type by asking: what will the next session DO?

**Discussion continuation**: Next session will explore, debate, decide.
- Needs: prior decisions (locked), the topic, reference docs, the discussion workflow, open questions
- Doesn't need: code state, test results, implementation details

**Plan to build**: Next session will implement a plan.
- Needs: plan artifact location/state, which task to start, key architecture facts discovered during planning, skills for implementation, files to read first
- Doesn't need: the planning discussion, rejected alternatives (unless they're traps the builder might fall into)

**Build to build**: Next session continues implementation.
- Needs: what's done, what's next, what failed (with why), test state, uncommitted work
- Doesn't need: design rationale (it's in the plan/ADR), setup instructions

**Research chain**: Next session will analyze the next item in a sequence.
- Needs: protocol/methodology, findings so far, next target, where to persist output
- Doesn't need: full findings from prior sessions (reference the artifact instead)

**Context reset (same task)**: Fresh session on same work, context was getting stale.
- Needs: compressed current state, immediate next action, blockers
- Doesn't need: history of how we got here

## The Non-Duplication Rule

This is the load-bearing constraint. Never copy content that exists in a file.

- Plan exists in `plan_tasks` or `PLAN.md`? Reference it: "Active plan: X, next task: Y"
- Decision exists in an ADR? Reference: "Read docs/decisions/003-auth.md"
- Code pattern exists in a file? Reference: "See internal/auth/handler.go lines 40-60"

Duplicate only what lives solely in the conversation: decisions made verbally, failed approaches tried, architectural insights not yet written anywhere.

## When to Ask the User

Ask when you genuinely can't infer. Don't ask for things you can gather automatically.

**Don't ask (gather yourself)**:
- Plan state (call plan_tasks or read PLAN.md)
- Git state (branch, dirty files, recent commits)
- Which files were modified (you know from the session)

**Ask (1-2 questions max)**:
- "What should the next session focus on?" (if no goal was provided and it's ambiguous)
- "Were there decisions made this session that aren't captured in any file yet?"
- "Anything you tried that didn't work that the next session should avoid?"

Skip questions when the goal makes the answers obvious. "/handoff implement phase 5" tells you everything.

## Quality Signals

A good handoff:
- Fits in <80 lines (the receiver's context window is precious too)
- Has a clear one-line goal at the top
- References files by path, not by copying their content
- Mentions skills/methodology the next session should load
- Includes failed approaches only when the next session might repeat them
- States decisions as facts, not as arguments (the debate is over)

A bad handoff:
- Reads like a session transcript summary
- Copies code snippets that exist in files
- Includes context the receiver would load anyway (plan_tasks auto-injects plan state)
- Lists every file touched (git diff does this)
- Argues for decisions instead of stating them

## NEVER

- **NEVER copy file content into the handoff** -- reference by path. The receiver has read access; duplicating wastes tokens and drifts from the source.
- **NEVER include plan state that plan_tasks already injects** -- the system prompt auto-shows active plan, next task, ACs. Only add plan context if it's NOT auto-injected (e.g., a plain PLAN.md or babysitter process).
- **NEVER write a retrospective** -- "we discussed X, then tried Y, then decided Z" is a journal. Write "Decision: Z. Read Y for context." The receiver needs conclusions, not narrative.
- **NEVER ask more than 2 questions** -- if you need more than 2 answers to write the handoff, you don't understand the session well enough. Re-read the conversation.
- **NEVER include setup or obvious context** -- "this is a TypeScript project using..." is something the receiver discovers in 5 seconds from package.json. Only include what's genuinely non-obvious.
- **NEVER omit failed approaches when the receiver might repeat them** -- if you spent 30 minutes on an approach that didn't work, and the next session's goal would lead them down the same path, that's the highest-value content in the handoff.

## Output

Write the handoff to `~/.pi/handoffs/<repo-slug>/latest.md`. The extension handles the path; use the `write` tool with the path shown in the handoff request.

Include YAML frontmatter with: goal, repo, created timestamp. Add plan name if a plan is active.
