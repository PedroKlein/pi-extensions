---
name: pi-repos
description: >-
  Manage, search, annotate, and connect repositories using pi-repos tools. Use when working across
  multiple repos, discovering architecture patterns, needing context from external projects,
  searching across codebases, or persisting knowledge about repos for future sessions. Triggers on:
  repos_annotate, repos_search, repos_add, repos_reference, repos_group, cross-repo, multi-repo,
  repo management, clone, annotate a repo, register a repo, group workspace, connections, references.
  Do NOT use for: general git operations (use github skill), creating worktrees (use repos wt directly).
---

# pi-repos — Workflow Skill

Use pi-repos tools to manage, search, and annotate repositories. This skill teaches **when** to reach for these tools.

## Triggers

- Working in or across multiple related repositories
- Discovering architecture patterns, gotchas, or design decisions
- Needing context from an external project (library internals, API shapes)
- Searching for something that might span multiple codebases
- Exploring unfamiliar code and wanting to persist what you learn

## When to Annotate (`repos_annotate`)

This is the tool agents most underuse. Reach for it when:

**Before annotating, ask yourself:**
1. Does an annotation for this insight already exist? (`repos_info` on the repo first — don't duplicate)
2. Which category captures the MOST IMPORTANT aspect? If it fits both `pattern` and `decision`, use `decision` — decisions are harder to reconstruct later.
3. Will a future session benefit from this, or is this project-specific ephemera? If it won't generalize beyond this task, skip it.

Annotate when:

- **You discover HOW repos connect** → category: `architecture`
- **You find a reusable pattern** (error handling, config approach) → category: `pattern`
- **You hit a gotcha or footgun** → category: `bug`
- **You understand WHY something was designed a certain way** → category: `decision`
- **You notice something that spans multiple repos** → category: `cross-cutting`

Rule of thumb: if you just learned something about a repo that would help a future session, annotate it NOW before it evaporates from context.

## When to Use References (`repos_reference`)

References are "this repo/group knows about these other repos for context." Use when:

- A repo uses a library/framework and you need its source for API understanding
- A group has context dependencies (e.g., CRD providers whose API shapes matter)
- You'd otherwise `fetch_content` from GitHub — check if the repo is already available locally via a reference

**On session start**, if your cwd is in a managed repo with references, they're injected with paths. Use those paths with `read` directly — no need to fetch from GitHub.

## When to Check Connections

- Before making changes that might affect other repos in the group
- When you need to understand the data flow through a system
- When onboarding to a new group of repos — run `repos_group info` first

## When to Search Across Repos (`repos_search`)

- Looking for how a type/interface is used across services
- Finding all consumers of a shared schema
- Searching for configuration patterns across environments
- Tracing error messages to their source

Tip: scope to a group for relevant results: `repos_search { pattern: "...", group: "infra" }`

## When to Add Repos (`repos_add`)

**Before adding, ask yourself:**
1. Is this repo already a reference in the active group? (`repos_group info` — adding a duplicate fragments annotations)
2. Will you need this in more than one future session, or just today? If one-off, read it directly without registering.
3. Do you need a specific version? Use the `tag` param — otherwise you pull main which may not match the library version in use.

Add when:
- You keep referencing a repo or fetching from GitHub — just clone it
- You need to understand an external library's internals (use `tag` param for specific version)
- A new repo joins the team's ecosystem

## Group Workspace

Each group has a `docs/` workspace (shown on session start). The agent can:
- **Read** architecture.md, roles.md, glossary.md, map.md for system understanding
- **Write** findings, meeting notes, investigation results directly to docs/
- **Regenerate** AI docs: `repos_group { action: "docs", name: "...", docAction: "regenerate" }`

The workspace path is absolute — use `read`/`edit` tools directly, no need for the `repos_group docs` tool for routine access.

## When to Suggest Connections

After adding multiple repos to a group, if connections aren't defined:
```
repos_group { action: "suggest", name: "my-group" }
```
Review suggestions, then confirm with `repos_group connect` for each valid one.

## NEVER

- **NEVER annotate without checking existing annotations first** — duplicate or contradictory annotations fragment the knowledge graph; run `repos_info` on the repo first to see what's already captured, then decide if this adds new signal or just echoes what's there
- **NEVER search without group scope when the registry has 20+ repos** — unscoped `repos_search` returns matches from every repo including references and archived entries, producing a wall of noise that buries the relevant results; always pass `group:` when you know the relevant system
- **NEVER write to group docs/ without reading the existing content first** — group docs accumulate knowledge across sessions; overwriting without reading loses prior session discoveries that took significant context to produce and cannot be reconstructed
- **NEVER add a repo that's already registered as a reference in the current group** — creates a duplicate entry that fragments annotations between the reference and the full registration; check `repos_group info` before `repos_add`
- **NEVER use category `cross-cutting` when `architecture` or `decision` is more specific** — `cross-cutting` is the catch-all bucket; over-using it makes the category meaningless and annotations unfindable in future sessions; default to the most specific category that fits
