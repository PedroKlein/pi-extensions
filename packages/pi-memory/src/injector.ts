/**
 * injector.ts — Lightweight memory context injection.
 *
 * Only injects PINNED facts — critical behavioral preferences that must
 * always be available without explicit search. Everything else (project
 * context, lessons, tool prefs) is available on-demand via memory_search.
 *
 * Injected once at session_start and cached for the session.
 */
import type { MemoryStore, SemanticEntry } from "./store.js";

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

// Re-export for backward compat (used by index.ts for category-map loading in dream)
export interface CategoryMap {
  _always: string[];
  [projectSlug: string]: string[];
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CATEGORY_MAP_PATH = join(homedir(), ".pi", "memory", "category-map.json");

const DEFAULT_CATEGORY_MAP: CategoryMap = {
  _always: ["general"],
};

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

// ─── Pinned-Only Block Builder ───────────────────────────────────────

/**
 * Build the memory context block from pinned facts only.
 *
 * Pinned facts are critical behavioral preferences the agent must always
 * have (e.g., code style, workflow rules). Everything else is on-demand
 * via memory_search/memory_lessons tools.
 */
export function buildDeterministicBlock(
  store: MemoryStore,
  cwd: string,
  _categoryMap: CategoryMap,
): ContextBlock {
  const slug = projectSlug(cwd);
  const pinnedFacts = store.listPinned();
  const stats = store.stats();

  // Build the dynamic footer with stats so the agent knows what's available
  const footer = buildMemoryFooter(slug, stats.semantic, stats.lessons);

  if (pinnedFacts.length === 0) {
    return {
      text: `<memory>\n${footer}\n</memory>`,
      stats: { facts: 0, lessons: 0 },
      factKeys: [],
      lessonCategories: [],
      displayLine: buildDisplayLine(slug, stats.semantic, stats.lessons, pinnedFacts),
    };
  }

  // Track access time
  store.touchAccessed(pinnedFacts.map(f => f.key));

  // Format pinned facts
  const formatted = pinnedFacts.map(formatPinnedFact);
  const factKeys = pinnedFacts.map(f => f.key);

  const text = [
    "<memory>",
    "## Pinned Preferences",
    ...formatted.map(f => `- ${f}`),
    "",
    footer,
    "</memory>",
  ].join("\n");

  return {
    text,
    stats: { facts: pinnedFacts.length, lessons: 0 },
    factKeys,
    lessonCategories: [],
    displayLine: buildDisplayLine(slug, stats.semantic, stats.lessons, pinnedFacts),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatPinnedFact(entry: SemanticEntry): string {
  return `${entry.key}: ${entry.value}`;
}

function buildDisplayLine(
  slug: string,
  totalFacts: number,
  totalLessons: number,
  pinnedFacts: SemanticEntry[],
): string {
  const parts: string[] = [];
  if (slug) parts.push(slug);
  parts.push(`📌 ${pinnedFacts.length} pinned`);
  parts.push(`${totalFacts} facts, ${totalLessons} lessons searchable`);
  return `🧠 ${parts.join(" | ")}`;
}

function buildMemoryFooter(slug: string, totalFacts: number, totalLessons: number): string {
  const available = `${totalFacts} facts and ${totalLessons} lessons available`;
  const projectHint = slug ? `Project: ${slug}` : "";
  return [
    `## Memory (${available} — use memory_search)`,
    projectHint,
    "- BEFORE starting work: search for relevant project context and user preferences",
    "- On errors or unexpected behavior: search for known issues in that domain",
    "- Before ask_user on workflow questions: check if memory already has the answer",
    "- After significant decisions: persist with memory_remember (pin critical ones)",
    "- Use memory_lessons to check learned corrections for the current domain",
    "- If a memory conflicts with current code, trust the code.",
  ].filter(Boolean).join("\n");
}

export function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", "users", "dev", "personal"]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}
