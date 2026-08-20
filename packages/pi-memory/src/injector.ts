/**
 * injector.ts — Lightweight memory context injection.
 *
 * Only injects PINNED facts — critical behavioral preferences that must
 * always be available without explicit search. Everything else (project
 * context, lessons, tool prefs) is available on-demand via memory_search.
 *
 * Injected once at session_start and cached for the session.
 */
import { encode } from "gpt-tokenizer/encoding/o200k_base";
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
  estimatedTokens: number;
  budgetExceeded: boolean;
  omittedFacts: number;
}

export interface BlockOptions {
  tokenBudget?: number;
  onBudgetExceeded?: (message: string) => void;
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
  options: BlockOptions = {},
): ContextBlock {
  const slug = projectSlug(cwd);
  const tokenBudget = options.tokenBudget ?? 500;
  const pinnedFacts = store
    .listPinned()
    .filter((entry) => matchesProjectScope(entry, slug));
  const selected: SemanticEntry[] = [];

  for (const entry of pinnedFacts) {
    const candidate = renderPinnedBlock([...selected, entry]);
    if (encode(candidate).length > tokenBudget) break;
    selected.push(entry);
  }

  const omittedFacts = pinnedFacts.length - selected.length;
  const budgetExceeded = omittedFacts > 0;
  const text = selected.length > 0 ? renderPinnedBlock(selected) : "";
  const estimatedTokens = text ? encode(text).length : 0;
  const stats = store.stats();

  if (selected.length > 0) {
    store.touchAccessed(selected.map((entry) => entry.key));
  }
  if (budgetExceeded) {
    options.onBudgetExceeded?.(
      `Pinned preferences exceed the ${tokenBudget}-token pinned-memory budget; ` +
        `${omittedFacts} fact(s) were omitted in stable key order.`,
    );
  }

  return {
    text,
    stats: { facts: selected.length, lessons: 0 },
    factKeys: selected.map((entry) => entry.key),
    lessonCategories: [],
    displayLine: buildDisplayLine(
      slug,
      stats.semantic,
      stats.lessons,
      selected,
    ),
    estimatedTokens,
    budgetExceeded,
    omittedFacts,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatPinnedFact(entry: SemanticEntry): string {
  return `${entry.key}: ${entry.value}`;
}

function matchesProjectScope(entry: SemanticEntry, slug: string): boolean {
  const [scope, project] = entry.key.toLowerCase().split(".");
  return scope !== "project" || project === slug;
}

function renderPinnedBlock(entries: SemanticEntry[]): string {
  return [
    "<memory>",
    "## Pinned Preferences",
    ...entries.map((entry) => `- ${formatPinnedFact(entry)}`),
    "</memory>",
  ].join("\n");
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

export function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", "users", "dev", "personal"]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}
