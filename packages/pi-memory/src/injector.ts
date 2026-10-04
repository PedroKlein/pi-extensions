import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { MemoryStore, SemanticEntry } from "./store.js";

export interface ContextBlock {
  text: string;
  stats: { facts: number };
  factKeys: string[];
  displayLine: string;
  estimatedTokens: number;
  budgetExceeded: boolean;
  omittedFacts: number;
}

export interface BlockOptions {
  tokenBudget?: number;
  onBudgetExceeded?: (message: string) => void;
}

export function buildDeterministicBlock(
  store: MemoryStore,
  cwd: string,
  options: BlockOptions = {},
): ContextBlock {
  const slug = projectSlug(cwd);
  const tokenBudget = options.tokenBudget ?? 500;
  const pinnedFacts = store
    .listPinned()
    .filter((entry) => matchesProjectScope(entry, slug));
  const selected: SemanticEntry[] = [];

  for (const entry of pinnedFacts) {
    const candidate = renderWrappedPinnedBlock([...selected, entry]);
    if (encode(candidate).length > tokenBudget) break;
    selected.push(entry);
  }

  const omittedFacts = pinnedFacts.length - selected.length;
  const text = selected.length > 0 ? renderPinnedBlock(selected) : "";

  if (omittedFacts > 0) {
    options.onBudgetExceeded?.(
      `Pinned preferences exceed the ${tokenBudget}-token pinned-memory budget; ` +
        `${omittedFacts} fact(s) were omitted in stable key order.`,
    );
  }

  return {
    text,
    stats: { facts: selected.length },
    factKeys: selected.map((entry) => entry.key),
    displayLine: buildDisplayLine(slug, store.stats().semantic, selected),
    estimatedTokens: text ? encode(renderWrappedPinnedBlock(selected)).length : 0,
    budgetExceeded: omittedFacts > 0,
    omittedFacts,
  };
}

function matchesProjectScope(entry: SemanticEntry, slug: string): boolean {
  const [scope, project] = entry.key.toLowerCase().split(".");
  return scope !== "project" || project === slug;
}

function renderPinnedBlock(entries: SemanticEntry[]): string {
  return [
    "## Pinned Preferences",
    ...entries.map((entry) => `- ${entry.key}: ${entry.value}`),
  ].join("\n");
}

function renderWrappedPinnedBlock(entries: SemanticEntry[]): string {
  return `<memory>\n${renderPinnedBlock(entries)}\n</memory>`;
}

function buildDisplayLine(
  slug: string,
  totalFacts: number,
  pinnedFacts: SemanticEntry[],
): string {
  const parts: string[] = [];
  if (slug) parts.push(slug);
  parts.push(`📌 ${pinnedFacts.length} pinned`);
  parts.push(`${totalFacts} facts searchable`);
  return `🧠 ${parts.join(" | ")}`;
}

export function projectSlug(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const name = basename(current).toLowerCase();
      if ((name === "main" || name === "master") && existsSync(join(dirname(current), ".bare"))) {
        return basename(dirname(current)).toLowerCase();
      }
      return name;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return basename(cwd).toLowerCase();
}
