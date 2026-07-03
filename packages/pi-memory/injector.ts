/**
 * injector.ts — Deterministic memory context injection.
 *
 * Builds a context block from memory for injection into the system prompt.
 * No LLM, no search, no per-turn logic. Just prefix-based fact loading
 * and category-filtered lessons from a static mapping file.
 *
 * Injected once at session_start and cached for the session.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";

const MAX_CONTEXT_CHARS = 10000;

// ─── Types ───────────────────────────────────────────────────────────

export interface ContextBlock {
  text: string;
  stats: { facts: number; lessons: number };
  /** Matched fact keys (dotted paths) for display */
  factKeys: string[];
  /** Unique lesson categories that were injected */
  lessonCategories: string[];
  /** Compact one-line display string */
  displayLine: string;
}

export interface CategoryMap {
  _always: string[];
  [projectSlug: string]: string[];
}

// ─── Category Map Loader ─────────────────────────────────────────────

const CATEGORY_MAP_PATH = join(homedir(), ".pi", "memory", "category-map.json");

const DEFAULT_CATEGORY_MAP: CategoryMap = {
  _always: ["general"],
};

/**
 * Load the category map from ~/.pi/memory/category-map.json.
 * Falls back to { _always: ["general"] } if file doesn't exist or is invalid.
 */
export function loadCategoryMap(): CategoryMap {
  try {
    const raw = readFileSync(CATEGORY_MAP_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed._always)) {
      return DEFAULT_CATEGORY_MAP;
    }
    return parsed as CategoryMap;
  } catch {
    return DEFAULT_CATEGORY_MAP;
  }
}

/**
 * Get the set of lesson categories to inject for a given project slug.
 */
function getActiveCategories(categoryMap: CategoryMap, slug: string): Set<string> {
  const categories = new Set<string>(categoryMap._always || ["general"]);
  const projectCategories = categoryMap[slug];
  if (Array.isArray(projectCategories)) {
    for (const cat of projectCategories) {
      categories.add(cat);
    }
  }
  return categories;
}

// ─── Deterministic Block Builder ─────────────────────────────────────

/**
 * Build the memory context block deterministically.
 *
 * - Facts: project.{slug}.* + pref.* + tool.*
 * - Lessons: filtered by category map (project categories + _always)
 *
 * No search, no LLM, no per-turn logic.
 */
export function buildDeterministicBlock(
  store: MemoryStore,
  cwd: string,
  categoryMap: CategoryMap,
): ContextBlock {
  const slug = projectSlug(cwd);
  const sections: string[] = [];
  const allFactKeys: string[] = [];

  // ── Facts: project-scoped + preferences + tools ───────────────────
  const projectFacts = slug ? store.listSemantic(`project.${slug}.`, 50) : [];
  const prefs = store.listSemantic("pref.", 50);
  const tools = store.listSemantic("tool.", 30);
  const userFacts = store.listSemantic("user.", 10);

  if (projectFacts.length > 0) {
    sections.push(formatSection("Project Context", projectFacts.map(formatSemantic)));
    allFactKeys.push(...projectFacts.map(f => f.key));
  }

  if (prefs.length > 0) {
    sections.push(formatSection("Preferences", prefs.map(formatSemantic)));
    allFactKeys.push(...prefs.map(f => f.key));
  }

  if (tools.length > 0) {
    sections.push(formatSection("Tool Preferences", tools.map(formatSemantic)));
    allFactKeys.push(...tools.map(f => f.key));
  }

  if (userFacts.length > 0) {
    sections.push(formatSection("User", userFacts.map(formatSemantic)));
    allFactKeys.push(...userFacts.map(f => f.key));
  }

  // Track access time
  if (allFactKeys.length > 0) {
    store.touchAccessed(allFactKeys);
  }

  // ── Lessons: category-filtered ────────────────────────────────────
  const activeCategories = getActiveCategories(categoryMap, slug);
  const allLessons = store.listLessons(undefined, 500); // get all, filter locally
  const filteredLessons = allLessons.filter(l => activeCategories.has(l.category));

  const lessonCategorySet = new Set<string>();
  if (filteredLessons.length > 0) {
    const corrections = filteredLessons.filter(l => l.negative);
    const positives = filteredLessons.filter(l => !l.negative);

    for (const l of filteredLessons) {
      lessonCategorySet.add(l.category);
    }

    if (corrections.length > 0) {
      const formatted = corrections.map(l =>
        `DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Learned Corrections", formatted));
    }
    if (positives.length > 0) {
      const formatted = positives.map(l =>
        `${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Validated Approaches", formatted));
    }
  }

  // ── Empty check ───────────────────────────────────────────────────
  if (sections.length === 0) {
    return {
      text: "",
      stats: { facts: 0, lessons: 0 },
      factKeys: [],
      lessonCategories: [],
      displayLine: "🧠 (empty)",
    };
  }

  // ── Assemble final block ──────────────────────────────────────────
  let text = `<memory>\n${sections.join("\n")}\n\n${MEMORY_FOOTER}\n</memory>`;

  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>";
  }

  const lessonCategories = [...lessonCategorySet].sort();

  // ── Display line ──────────────────────────────────────────────────
  const displayLine = buildDisplayLine(slug, allFactKeys.length, filteredLessons.length, lessonCategories);

  return {
    text,
    stats: { facts: allFactKeys.length, lessons: filteredLessons.length },
    factKeys: allFactKeys,
    lessonCategories,
    displayLine,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatSection(title: string, items: string[]): string {
  return `## ${title}\n${items.map(i => `- ${i}`).join("\n")}`;
}

/** Staleness thresholds (in days) */
const STALE_WARNING_DAYS = 30;
const VERY_STALE_DAYS = 90;

function formatSemantic(entry: SemanticEntry): string {
  const key = entry.key.split(".").slice(1).join(".");
  const ageDays = daysSince(entry.updated_at);
  const staleTag = ageDays >= VERY_STALE_DAYS
    ? ` ⚠️ ${ageDays}d old — verify before acting on this`
    : ageDays >= STALE_WARNING_DAYS
      ? ` (${ageDays}d ago)`
      : "";
  return `${key}: ${entry.value}${staleTag}`;
}

function daysSince(dateStr: string): number {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Build the compact 🧠 display line.
 * Example: 🧠 project.dotfiles (4) | pref (20) | tool (10) | lessons: 42 [pi-memory, pi-baml, workflow, ...]
 */
function buildDisplayLine(
  slug: string,
  factCount: number,
  lessonCount: number,
  categories: string[],
): string {
  const parts: string[] = [];

  if (slug) {
    parts.push(`project.${slug}`);
  }
  parts.push(`${factCount} facts`);
  if (lessonCount > 0) {
    const categoryPreview = categories.slice(0, 5).join(", ");
    const suffix = categories.length > 5 ? ` +${categories.length - 5}` : "";
    parts.push(`${lessonCount} lessons [${categoryPreview}${suffix}]`);
  }

  return `🧠 ${parts.join(" | ")}`;
}

const MEMORY_FOOTER = `## Using Memory Proactively
- On bash errors or unexpected behavior: run memory_search for the error domain BEFORE retrying.
- Before ask_user on workflow/scope questions: check if memory already has the answer.
- For complex tasks spanning 3+ files or requiring research: use subagents (scout for recon, worker for parallel implementation, researcher for deep dives).
- After significant decisions or discoveries: persist them with memory_remember.
- Memory above covers the current project context. For other domains, use memory_search.
- If a memory conflicts with what you observe in current code, trust the code.`;

function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", "users", "dev", "personal"]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}
