/**
 * dream/chain-prep.ts — Prepare chain_dir with context files for the subagent chain.
 *
 * Writes:
 * - sessions/batch-N.json — session data grouped for parallel miners
 * - current-memory.json — full snapshot of semantic facts + lessons
 * - skills.md — dynamically selected skill content based on session keywords
 * - meta.json — run metadata
 */
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryStore } from "../store.js";
import type { ExtractedSession } from "./session-reader.js";
import type { DreamConfig } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  keywords: string[];
}

export interface ChainMeta {
  runId: string;
  timestamp: string;
  sessionCount: number;
  projects: string[];
  dateRange: { from: string; to: string };
  config: {
    minerModel: string;
    refinerModel: string;
    advisorModel: string;
  };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Prepare the chain_dir with all context files for the dream subagent chain.
 */
export function prepareChainDir(
  chainDir: string,
  sessions: ExtractedSession[],
  store: MemoryStore,
  config: DreamConfig,
  runId: string
): ChainMeta {
  // Ensure chain_dir structure
  const sessionsDir = join(chainDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  // 1. Write session batches
  writeSessionBatches(sessionsDir, sessions);

  // 2. Write current memory snapshot
  writeMemorySnapshot(chainDir, store);

  // 3. Write relevant skills (content for REFINE)
  writeRelevantSkills(chainDir, sessions, config.skillsDir);

  // 4. Write full skills listing (names only, for ADVISE to avoid false positives)
  writeSkillsListing(chainDir, config.skillsDir);

  // 5. Write metadata
  const projects = [...new Set(sessions.map(s => s.project))];
  const timestamps = sessions.map(s => s.timestamp).filter(t => t !== "unknown").sort();
  const meta: ChainMeta = {
    runId,
    timestamp: new Date().toISOString(),
    sessionCount: sessions.length,
    projects,
    dateRange: {
      from: timestamps[0] || "unknown",
      to: timestamps[timestamps.length - 1] || "unknown",
    },
    config: {
      minerModel: config.minerModel,
      refinerModel: config.refinerModel,
      advisorModel: config.advisorModel,
    },
  };
  writeFileSync(join(chainDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  return meta;
}

// ─── Session Batches ─────────────────────────────────────────────────

/** Max serialized JSON size per batch (400KB keeps well within model context limits) */
const MAX_BATCH_BYTES = 400 * 1024;

function writeSessionBatches(dir: string, sessions: ExtractedSession[]): void {
  // Build serialized entries first so we can measure byte sizes
  const entries = sessions.map(s => ({
    path: s.path,
    project: s.project,
    timestamp: s.timestamp,
    conversation: formatConversation(s),
    toolSummary: formatToolSummary(s),
  }));

  // Pack into batches by byte budget (400KB max per batch)
  const batches: (typeof entries)[] = [];
  let currentBatch: typeof entries = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const entryBytes = JSON.stringify(entry).length;

    // If adding this entry would exceed budget, start a new batch
    // (unless the current batch is empty — always add at least one entry per batch)
    if (currentBatch.length > 0 && currentBytes + entryBytes > MAX_BATCH_BYTES) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(entry);
    currentBytes += entryBytes;
  }

  // Push the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Write batch files
  for (let i = 0; i < batches.length; i++) {
    writeFileSync(join(dir, `batch-${i}.json`), JSON.stringify(batches[i], null, 2), "utf-8");
  }
}

function formatConversation(session: ExtractedSession): string {
  const lines: string[] = [];
  const maxPairs = Math.max(session.userMessages.length, session.assistantMessages.length);

  for (let i = 0; i < maxPairs; i++) {
    if (session.userMessages[i]) {
      lines.push(`User: ${session.userMessages[i]}`);
    }
    if (session.assistantMessages[i]) {
      lines.push(`Assistant: ${session.assistantMessages[i]}`);
    }
  }

  return lines.join("\n\n");
}

function formatToolSummary(session: ExtractedSession): string {
  if (session.toolCalls.length === 0) return "No tool calls recorded.";

  // Aggregate by tool name
  const counts: Record<string, { total: number; errors: number }> = {};
  for (const tc of session.toolCalls) {
    if (!counts[tc.name]) counts[tc.name] = { total: 0, errors: 0 };
    counts[tc.name].total++;
    if (!tc.success) counts[tc.name].errors++;
  }

  return Object.entries(counts)
    .map(([name, { total, errors }]) =>
      errors > 0 ? `${name}: ${total} calls (${errors} errors)` : `${name}: ${total} calls`)
    .join(", ");
}

// ─── Memory Snapshot ─────────────────────────────────────────────────

function writeMemorySnapshot(chainDir: string, store: MemoryStore): void {
  const facts = store.listSemantic(undefined, 500).map(f => ({
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    updated_at: f.updated_at,
  }));

  const lessons = store.listLessons(undefined, 200).map(l => ({
    rule: l.rule,
    category: l.category,
    negative: l.negative,
  }));

  const snapshot = { facts, lessons, stats: { factCount: facts.length, lessonCount: lessons.length } };
  writeFileSync(join(chainDir, "current-memory.json"), JSON.stringify(snapshot, null, 2), "utf-8");
}

// ─── Skill Selection ─────────────────────────────────────────────────

function writeRelevantSkills(chainDir: string, sessions: ExtractedSession[], skillsDir: string): void {
  const skills = discoverSkills(skillsDir);
  if (skills.length === 0) {
    writeFileSync(join(chainDir, "skills.md"), "No skills found.", "utf-8");
    return;
  }

  // Extract keywords from all sessions
  const sessionKeywords = extractSessionKeywords(sessions);

  // Score skills by keyword overlap
  const scored = skills.map(skill => {
    const overlap = skill.keywords.filter(kw => sessionKeywords.has(kw)).length;
    return { skill, score: overlap };
  }).filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // Top 8 relevant skills

  if (scored.length === 0) {
    // Fallback: include top 3 most general skills
    const fallback = skills.slice(0, 3);
    const content = fallback.map(s => formatSkillContent(s)).join("\n\n---\n\n");
    writeFileSync(join(chainDir, "skills.md"), content, "utf-8");
    return;
  }

  const content = scored.map(s => formatSkillContent(s.skill)).join("\n\n---\n\n");
  writeFileSync(join(chainDir, "skills.md"), content, "utf-8");
}

function discoverSkills(skillsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(skillsDir)) return skills;

  try {
    const entries = readdirSync(skillsDir);
    for (const entry of entries) {
      const skillPath = join(skillsDir, entry, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const content = readFileSync(skillPath, "utf-8");
        const description = extractSkillDescription(content);
        const keywords = extractSkillKeywords(content, entry);
        skills.push({ name: entry, description, filePath: skillPath, keywords });
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir unreadable */ }

  return skills;
}

function extractSkillDescription(content: string): string {
  // Look for description in frontmatter or first paragraph
  const descMatch = content.match(/description:\s*(.+)/);
  if (descMatch) return descMatch[1].trim();

  // First non-header, non-empty line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }
  return "";
}

function extractSkillKeywords(content: string, name: string): string[] {
  const text = `${name} ${content.slice(0, 2000)}`.toLowerCase();
  const words = text
    .replace(/[^a-z0-9-_./\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Deduplicate and return unique meaningful terms
  return [...new Set(words)].slice(0, 50);
}

function extractSessionKeywords(sessions: ExtractedSession[]): Set<string> {
  const keywords = new Set<string>();

  for (const session of sessions) {
    // From user messages
    for (const msg of session.userMessages.slice(0, 5)) { // First 5 user msgs
      const words = msg.toLowerCase().replace(/[^a-z0-9-_./\s]/g, " ").split(/\s+/);
      for (const w of words) {
        if (w.length > 3) keywords.add(w);
      }
    }
    // From tool calls
    for (const tc of session.toolCalls) {
      keywords.add(tc.name.toLowerCase());
    }
    // From project name
    keywords.add(session.project);
  }

  return keywords;
}

function formatSkillContent(skill: SkillInfo): string {
  try {
    const content = readFileSync(skill.filePath, "utf-8");
    // Cap at 3000 chars per skill
    const truncated = content.length > 3000
      ? content.slice(0, 3000) + "\n\n[... truncated]"
      : content;
    return `# Skill: ${skill.name}\n\n${truncated}`;
  } catch {
    return `# Skill: ${skill.name}\n\n${skill.description}`;
  }
}

// ─── Skills Listing (for ADVISE) ─────────────────────────────────────

/**
 * Write a complete listing of all available skills (names + descriptions)
 * so the Advisor knows what exists and doesn't recommend creating duplicates.
 */
function writeSkillsListing(chainDir: string, skillsDir: string): void {
  const skills = discoverSkills(skillsDir);

  // Also discover package skills from npm
  const npmSkillsDir = join(homedir(), ".pi", "agent", "npm", "node_modules");
  const packageSkills: Array<{ name: string; description: string }> = [];
  try {
    if (existsSync(npmSkillsDir)) {
      const packages = readdirSync(npmSkillsDir).filter((p: string) => !p.startsWith("."));
      for (const pkg of packages) {
        const pkgSkillsDir = join(npmSkillsDir, pkg, "skills");
        if (!existsSync(pkgSkillsDir)) continue;
        try {
          const skillEntries = readdirSync(pkgSkillsDir);
          for (const entry of skillEntries) {
            const skillPath = join(pkgSkillsDir, entry, "SKILL.md");
            if (!existsSync(skillPath)) continue;
            try {
              const content = readFileSync(skillPath, "utf-8");
              const desc = extractSkillDescription(content);
              packageSkills.push({ name: `${pkg}/${entry}`, description: desc });
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* npm dir not accessible */ }

  const lines: string[] = [
    "# Available Skills (DO NOT recommend creating these)",
    "",
    "## User Skills (~/.agents/skills/)",
    "",
  ];

  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description.slice(0, 150)}`);
  }

  if (packageSkills.length > 0) {
    lines.push("", "## Package Skills (installed via npm)", "");
    for (const ps of packageSkills) {
      lines.push(`- **${ps.name}**: ${ps.description.slice(0, 150)}`);
    }
  }

  writeFileSync(join(chainDir, "skills-listing.md"), lines.join("\n"), "utf-8");
}
