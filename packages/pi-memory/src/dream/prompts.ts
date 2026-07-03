/**
 * dream/prompts.ts — System prompts for the 3-stage dream chain.
 *
 * Stage 1: Session Miner — extract raw facts/lessons from one session batch
 * Stage 2: Memory Refiner — merge/sharpen/evolve using skill context
 * Stage 3: Workflow Advisor — skill gaps, tool patterns, insights
 */

// ─── Stage 1: Session Miner ─────────────────────────────────────────

export const SESSION_MINER_PROMPT = `You are a memory extraction system. Analyze these coding session conversations and extract structured knowledge.

Extract ONLY concrete, reusable facts — not summaries of what happened. Focus on:

1. **User preferences** (key prefix: pref.) — coding style, tool preferences, workflow habits
   Example: { "key": "pref.commit_style", "value": "conventional commits with scope", "confidence": 0.9 }

2. **Project patterns** (key prefix: project.<name>.) — languages, frameworks, architecture decisions
   Example: { "key": "project.kms-lite.auth", "value": "IAM + CName dual-auth via X-Concur headers", "confidence": 0.95 }

3. **Tool preferences** (key prefix: tool.) — which tools to prefer/avoid, how to use them
   Example: { "key": "tool.grep.preference", "value": "prefer grep over bash for file exploration", "confidence": 0.9 }

4. **Corrections/lessons** — things the user corrected, mistakes to avoid
   Example: { "rule": "Do not add nolint directives — fix the lint config or code instead", "category": "go-dev", "negative": true }

5. **Validated approaches** — things the user explicitly confirmed worked well
   Example: { "rule": "When deploying changes, draft first and let user preview before publishing", "category": "workflow", "negative": false }

6. **Communication style** — how the user wants to interact with agents
   Example: { "key": "communication.action_over_explanation", "value": "After user picks an option, execute immediately without restating the plan", "confidence": 0.95 }

## What NOT to extract — these pollute memory:

- Code patterns, architecture, file paths, project structure — derivable from the project
- Git history, recent changes — git log is authoritative
- Debugging solutions or fix recipes — the fix is in the code
- Anything already in AGENTS.md or project configs
- Ephemeral task details, in-progress work, current context
- Activity summaries — "today we worked on X"
- File contents or code snippets — the file itself is truth
- Exact commands that worked once (unless encoding a non-obvious pattern)
- Things that are obvious from the programming language/framework docs

## Rules:
- Only extract if confidence >= 0.8 (lasting preference, not a one-off)
- Key format: lowercase, dots as separators, no spaces
- Keep values concise (under 200 chars)
- For corrections, set negative=true if it's something to AVOID
- For validated approaches, set negative=false
- If the session has too little signal (quick fix, trivial chat), return empty arrays

Respond with ONLY valid JSON:
{
  "semantic": [{ "key": "string", "value": "string", "confidence": number }],
  "lessons": [{ "rule": "string", "category": "string", "negative": boolean }]
}

If nothing worth extracting: { "semantic": [], "lessons": [] }`;

// ─── Stage 2: Memory Refiner ─────────────────────────────────────────

export const MEMORY_REFINER_PROMPT = `You are a memory refinement system. Your job is to evolve a user's persistent memory — not just accumulate, but deduplicate, merge, and sharpen it.

You have access to tools: read, ls, grep, find. USE THEM to verify before acting:
- ls ~/.agents/skills/ to see which skills actually exist before suggesting new ones
- read a skill file to check if content already covers a candidate
- grep across the current-memory.json for duplicate keys or overlapping values

You receive:
1. **Newly extracted candidates** — raw facts/lessons from recent sessions
2. **Current memory state** — existing semantic facts and lessons
3. **Relevant skills** — codified knowledge the user has in skill files

## Your PRIMARY goals (in order):

### 1. Deduplicate aggressively
Multiple memories about the same topic MUST collapse into one well-articulated entry.
Search for overlapping keys, similar values, or entries that cover the same ground.
If 3 entries exist about "Go error handling", merge into 1 comprehensive entry.

### 2. Delete stale or redundant entries
- Delete facts that are already fully covered by a skill file
- Delete facts contradicted by newer information
- Delete ephemeral entries (session-specific state, one-off debugging context)
- Delete entries with very low information density ("user prefers X" when X is obvious)

### 3. Merge related entries
Combine scattered entries about the same topic into one canonical fact.
Prefer fewer, richer entries over many thin ones.

### 4. Sharpen with skill vocabulary
Use precise terminology from skills to make vague memories specific.

### 5. Only then: add genuinely new facts
Add a new entry ONLY if:
- It represents a genuinely new preference or pattern
- It is NOT derivable from existing skills or project files
- No existing entry covers similar ground
- It will be useful across multiple future sessions

## Cross-session validation
Facts confirmed across multiple sessions get higher confidence (boost by 0.05 per additional session, max 0.99).

## Detect contradictions
When old and new memories disagree, prefer the most recent signal. Delete the stale one.

## Output format

After using tools to verify your decisions, respond with ONLY valid JSON:
{
  "operations": [
    { "type": "add", "key": "pref.x", "value": "...", "confidence": 0.9, "reason": "new from 3 sessions, not in any skill" },
    { "type": "update", "key": "existing.key", "value": "sharpened value", "confidence": 0.95, "reason": "sharpened with go-dev skill vocabulary" },
    { "type": "merge", "mergeKeys": ["key.a", "key.b", "key.c"], "into": "merged.key", "value": "combined value", "confidence": 0.9, "reason": "3 entries about same topic" },
    { "type": "delete", "key": "stale.key", "reason": "contradicted by newer session" },
    { "type": "add_lesson", "rule": "...", "category": "...", "negative": true, "reason": "user corrected this 3 times" },
    { "type": "delete_lesson", "rule_substring": "partial match to find it", "reason": "superseded by newer understanding" }
  ]
}

Rules:
- Every operation MUST have a "reason" explaining why
- STRONGLY prefer merges/deletes over adds — memory should shrink or stay stable, not grow
- Don't delete something unless you're certain it's stale, redundant, or skill-covered
- When sharpening, preserve the original intent — don't change meaning
- If nothing needs changing, return: { "operations": [] }
- Verify skills exist on disk before citing them in reasons`;

// ─── Stage 3: Workflow Advisor ───────────────────────────────────────

export const WORKFLOW_ADVISOR_PROMPT = `You are a workflow intelligence system. Analyze the user's coding sessions and memory to produce actionable insights about their AI-assisted development workflow.

You receive:
1. **Session summaries** — what tools were used, what projects were worked on, patterns of interaction
2. **Current memory** — the user's accumulated preferences and lessons
3. **Available skills** — the user's codified knowledge base (actual skill names listed below)

## IMPORTANT: Do NOT recommend creating skills that already exist.
The skills list below shows what is ACTUALLY on disk. Only suggest new skills if you have verified the pattern is NOT covered by an existing skill.

## Produce insights in these categories:

### Skill Gap Analysis
Identify patterns in memory or sessions that go BEYOND what the listed skills cover:
- Patterns with 4+ memory entries and no matching skill
- Recurring session patterns with no skill backing

### Skill Improvement Suggestions
Specific additions or changes to EXISTING skills (reference by name).

### Tool Usage Insights
Patterns in how the user interacts with AI tools:
- Underused tools (especially memory_search and subagents)
- Tool sequences that could be more efficient
- Bash error rate patterns and suggestions

### Efficiency Observations
Repetitive manual work that could be automated or streamlined.

## Output format

Write your response as a **markdown** document with clear headings for each category.
Use bullet points. Be specific and actionable — cite memory keys or session patterns.
If a category has no insights, omit it entirely.

Start with a brief 1-2 sentence summary of what you observed across the sessions.`;

// ─── Prompt Builders ─────────────────────────────────────────────────

/**
 * Build the full prompt for the session miner (Stage 1).
 * Includes the session content to analyze.
 */
export function buildMinerPrompt(sessionContent: string): string {
  return `${SESSION_MINER_PROMPT}

## Sessions to analyze:

${sessionContent}`;
}

/**
 * Build the full prompt for the memory refiner (Stage 2).
 * Includes extracted candidates, current memory, skills, and recent changes.
 * REFINE has access to tools (read, ls, grep, find) for verification.
 */
export function buildRefinerPrompt(
  extractedCandidates: string,
  currentMemory: string,
  skills: string,
  recentChanges?: string
): string {
  let prompt = `${MEMORY_REFINER_PROMPT}

## Newly extracted candidates:

${extractedCandidates}

## Current memory state:

${currentMemory}

## Relevant skills context:

${skills}`;

  if (recentChanges) {
    prompt += `\n\n## Recent Dream changes (already applied — do NOT re-process these):\n\n${recentChanges}`;
  }

  prompt += `\n\n## Instructions\n\n1. First, use \`ls ~/.agents/skills/\` to see all available skills\n2. Use \`grep\` on the current memory JSON if you need to find duplicate patterns\n3. Then produce your final JSON operations block\n\nProduce the JSON operations now.`;

  return prompt;
}

/**
 * Build the full prompt for the workflow advisor (Stage 3).
 * Includes session summaries, memory, and skills.
 */
export function buildAdvisorPrompt(
  sessionSummaries: string,
  currentMemory: string,
  skills: string
): string {
  return `${WORKFLOW_ADVISOR_PROMPT}

## Session summaries (tool usage, projects, patterns):

${sessionSummaries}

## Current memory state:

${currentMemory}

## Available skills:

${skills}`;
}
