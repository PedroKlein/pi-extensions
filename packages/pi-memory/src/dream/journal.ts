/**
 * dream/journal.ts — Dream journal writer.
 *
 * Produces a timestamped markdown entry after each dream run.
 * Append-only: multiple dream runs on the same day get appended.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

/** Structured workflow insight (may be parsed from structured output or absent when shell-out returns raw markdown). */
export interface WorkflowInsight {
  type: "skill_gap" | "tool_pattern" | "efficiency" | "habit";
  title: string;
  detail: string;
  actionable: boolean;
  suggestion?: string;
}

export interface DreamJournalInput {
  runId: string;
  timestamp: Date;
  sessionsProcessed: number;
  projectsCovered: string[];
  dateRange: { from: string; to: string };
  memoryChanges: {
    added: Array<{ key: string; value: string }>;
    updated: Array<{ key: string; value: string; reason: string }>;
    merged: Array<{ from: string[]; into: string; value: string }>;
    deleted: Array<{ key: string; reason: string }>;
    lessonsAdded: Array<{ rule: string; category: string }>;
    lessonsDeleted: Array<{ rule: string; reason: string }>;
  };
  /** Facts the refiner suggests pinning (user decides). */
  pinSuggestions?: Array<{ key: string; reason: string }>;
  /** Workflow insights: structured array if parsed, or raw markdown string from shell-out. */
  workflowInsights: string | WorkflowInsight[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Format a dream journal entry as markdown.
 */
export function formatDreamJournal(input: DreamJournalInput): string {
  const sections: string[] = [];
  const time = input.timestamp.toISOString().slice(0, 19).replace("T", " ");

  sections.push(`## Dream Run — ${time}\n`);
  sections.push(`Run ID: \`${input.runId.slice(0, 8)}\`\n`);

  // Sessions Processed
  sections.push(`### Sessions Processed`);
  sections.push(`- **${input.sessionsProcessed}** sessions from ${input.dateRange.from} to ${input.dateRange.to}`);
  sections.push(`- Projects: ${input.projectsCovered.join(", ") || "none"}\n`);

  // Memory Changes
  const changes = input.memoryChanges;
  const totalChanges = changes.added.length + changes.updated.length + changes.merged.length +
    changes.deleted.length + changes.lessonsAdded.length + changes.lessonsDeleted.length;

  if (totalChanges > 0) {
    sections.push(`### Memory Changes`);

    if (changes.added.length > 0) {
      sections.push(`\n**Added (${changes.added.length})**`);
      for (const item of changes.added.slice(0, 10)) {
        sections.push(`- \`${item.key}\`: ${truncate(item.value, 100)}`);
      }
      if (changes.added.length > 10) sections.push(`- ... and ${changes.added.length - 10} more`);
    }

    if (changes.updated.length > 0) {
      sections.push(`\n**Updated (${changes.updated.length})**`);
      for (const item of changes.updated.slice(0, 10)) {
        sections.push(`- \`${item.key}\` → ${truncate(item.value, 80)} *(${item.reason})*`);
      }
      if (changes.updated.length > 10) sections.push(`- ... and ${changes.updated.length - 10} more`);
    }

    if (changes.merged.length > 0) {
      sections.push(`\n**Merged (${changes.merged.length})**`);
      for (const item of changes.merged.slice(0, 5)) {
        sections.push(`- ${item.from.map(k => `\`${k}\``).join(" + ")} → \`${item.into}\``);
      }
    }

    if (changes.deleted.length > 0) {
      sections.push(`\n**Deleted (${changes.deleted.length})**`);
      for (const item of changes.deleted.slice(0, 5)) {
        sections.push(`- ~~\`${item.key}\`~~ *(${item.reason})*`);
      }
    }

    if (changes.lessonsAdded.length > 0) {
      sections.push(`\n**Lessons Added (${changes.lessonsAdded.length})**`);
      for (const item of changes.lessonsAdded.slice(0, 10)) {
        sections.push(`- [${item.category}] ${truncate(item.rule, 120)}`);
      }
    }

    if (changes.lessonsDeleted.length > 0) {
      sections.push(`\n**Lessons Removed (${changes.lessonsDeleted.length})**`);
      for (const item of changes.lessonsDeleted.slice(0, 5)) {
        sections.push(`- ~~${truncate(item.rule, 80)}~~ *(${item.reason})*`);
      }
    }
  } else {
    sections.push(`### Memory Changes\n\nNo changes — memory is already well-consolidated.\n`);
  }

  // Pin Suggestions
  if (input.pinSuggestions && input.pinSuggestions.length > 0) {
    sections.push(`\n### 📌 Pin Suggestions`);
    sections.push(`\nThe refiner suggests pinning these facts for always-on context injection:`);
    for (const suggestion of input.pinSuggestions) {
      sections.push(`- \`${suggestion.key}\` — ${suggestion.reason}`);
    }
    sections.push(`\nTo pin: use \`memory_pin\` tool with action='pin' and the key.`);
  }

  // Workflow Insights
  if (input.workflowInsights) {
    if (Array.isArray(input.workflowInsights)) {
      if (input.workflowInsights.length > 0) {
        sections.push(`\n### Workflow Insights\n`);
        for (const insight of input.workflowInsights) {
          sections.push(`### [${insight.type}] ${insight.title}`);
          sections.push(insight.detail);
          if (insight.suggestion) {
            sections.push(`\n**Suggestion:** ${insight.suggestion}`);
          }
          sections.push("");
        }
      }
    } else if (input.workflowInsights.trim()) {
      sections.push(`\n### Workflow Insights\n`);
      sections.push(input.workflowInsights.trim());
    }
  }

  sections.push(`\n---\n`);

  return sections.join("\n");
}

/**
 * Write a dream journal entry to the configured directory.
 * Creates the directory if needed. Uses timestamp + runId for unique filenames.
 */
export function writeDreamJournal(journalDir: string, input: DreamJournalInput): string {
  // Ensure directory exists
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }

  // File name: YYYY-MM-DD_HHmmss_<runId>.md (unique per run)
  const ts = input.timestamp.toISOString();
  const dateStr = ts.slice(0, 10);
  const timeStr = ts.slice(11, 19).replace(/:/g, "");
  const runSlug = input.runId.slice(0, 8);
  const filePath = join(journalDir, `${dateStr}_${timeStr}_${runSlug}.md`);
  const content = formatDreamJournal(input);

  const header = `# Dream Journal — ${dateStr} ${ts.slice(11, 19)}\n\n`;
  writeFileSync(filePath, header + content, "utf-8");

  return filePath;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
