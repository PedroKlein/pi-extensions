/**
 * dream/orchestrator.ts — Main dream execution pipeline.
 *
 * Coordinates: gate checks → lock → session reading → chain prep →
 * chain execution → result application → journal writing → cleanup.
 *
 * All LLM calls use `pi --print` shell-out (no BAML dependency).
 * REFINE stage uses `pi --print --tools` for iterative exploration.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { MemoryStore } from "../store.js";
import type { DreamConfig } from "./config.js";
import { findAllSessionFiles, filterUnprocessed, parseSessionJSONL, type ExtractedSession } from "./session-reader.js";
import { prepareChainDir, type ChainMeta } from "./chain-prep.js";
import { buildMinerPrompt, buildRefinerPrompt, buildAdvisorPrompt } from "./prompts.js";
import { writeDreamJournal, type DreamJournalInput, type WorkflowInsight } from "./journal.js";

// ─── Types ───────────────────────────────────────────────────────────

type ExecFn = (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

interface DreamUI {
  setStatus(key: string, message: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface DreamResult {
  success: boolean;
  runId: string;
  sessionsProcessed: number;
  memoryChanges: {
    added: number;
    updated: number;
    merged: number;
    deleted: number;
    lessonsAdded: number;
    lessonsDeleted: number;
  };
  journalPath: string | null;
  error?: string;
}

interface MemoryOperation {
  type: "add" | "update" | "merge" | "delete" | "add_lesson" | "delete_lesson";
  key?: string;
  value?: string;
  confidence?: number;
  mergeKeys?: string[];
  into?: string;
  rule?: string;
  rule_substring?: string;
  category?: string;
  negative?: boolean;
  reason: string;
}

// ─── Logging ─────────────────────────────────────────────────────────

const DREAM_LOG_PATH = join(homedir(), ".pi", "memory", "dream.log");
/** Persistent dir for dream subprocess sessions (kept separate from main sessions) */
const DREAM_SESSIONS_DIR = join(homedir(), ".pi", "memory", "dream-sessions");

function dreamLog(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] ${msg}\n`;
  try {
    appendFileSync(DREAM_LOG_PATH, line, "utf-8");
  } catch {
    // If directory doesn't exist yet, create it
    try {
      mkdirSync(join(homedir(), ".pi", "memory"), { recursive: true });
      appendFileSync(DREAM_LOG_PATH, line, "utf-8");
    } catch { /* give up silently */ }
  }
}

function dreamLogError(stage: string, err: any): void {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack?.split("\n").slice(1, 4).join("\n  ") : "";
  dreamLog(`ERROR [${stage}] ${msg}`);
  if (stack) dreamLog(`  ${stack}`);
}

// ─── Gate Checks ─────────────────────────────────────────────────────

/**
 * Check all gates for auto-triggering. Returns true if dream should run.
 */
export function checkGates(store: MemoryStore, config: DreamConfig): boolean {
  // Gate 1: Time since last dream
  const lastDream = store.getDreamState("last_dream_at");
  if (lastDream) {
    const hoursSince = (Date.now() - new Date(lastDream).getTime()) / (1000 * 60 * 60);
    if (hoursSince < config.minHoursSinceDream) return false;
  }

  // Gate 2: Enough unprocessed sessions
  const allFiles = findAllSessionFiles(config.sessionsDir);
  const unprocessed = filterUnprocessed(allFiles, store);
  if (unprocessed.length < config.minSessionsSinceDream) return false;

  // Gate 3: Lock not held
  if (store.isDreamLocked()) return false;

  return true;
}

// ─── Main Execution ──────────────────────────────────────────────────

/**
 * Execute the full dream pipeline.
 */
export async function executeDream(
  store: MemoryStore,
  config: DreamConfig,
  exec: ExecFn,
  ui: DreamUI,
  options: { manual: boolean }
): Promise<DreamResult> {
  const runId = crypto.randomUUID();
  const pid = process.pid;

  // Acquire lock
  if (!store.acquireDreamLock(pid)) {
    dreamLog(`DREAM BLOCKED run=${runId.slice(0, 8)} -- lock held by another process`);
    return { success: false, runId, sessionsProcessed: 0, memoryChanges: emptyChanges(), journalPath: null, error: "Lock held by another process" };
  }

  dreamLog(`DREAM START run=${runId.slice(0, 8)} manual=${options.manual} pid=${pid}`);
  const startTime = Date.now();

  try {
    // Find unprocessed sessions
    ui.setStatus("pi-memory", "🌙 Dream: scanning sessions...");
    const allFiles = findAllSessionFiles(config.sessionsDir);
    let unprocessed = filterUnprocessed(allFiles, store);
    dreamLog(`SCAN found ${allFiles.length} total session files, ${unprocessed.length} unprocessed`);

    if (unprocessed.length === 0) {
      dreamLog(`DREAM SKIP -- no unprocessed sessions`);
      if (options.manual) {
        ui.notify("No new sessions to process", "info");
      }
      store.releaseDreamLock(pid);
      return { success: true, runId, sessionsProcessed: 0, memoryChanges: emptyChanges(), journalPath: null };
    }

    // Apply max sessions cap
    if (config.maxSessionsPerRun && unprocessed.length > config.maxSessionsPerRun) {
      dreamLog(`CAP applying maxSessionsPerRun=${config.maxSessionsPerRun} (${unprocessed.length} available)`);
      unprocessed = unprocessed.slice(0, config.maxSessionsPerRun);
    }

    // Parse sessions
    ui.setStatus("pi-memory", `🌙 Dream: parsing ${unprocessed.length} sessions...`);
    const sessions: ExtractedSession[] = [];
    for (const file of unprocessed) {
      const parsed = parseSessionJSONL(file);
      if (parsed.userMessages.length >= 2) { // Skip trivial sessions
        sessions.push(parsed);
      }
    }
    dreamLog(`PARSE ${unprocessed.length} sessions -> ${sessions.length} with content, ${unprocessed.length - sessions.length} trivial (skipped)`);

    if (sessions.length === 0) {
      dreamLog(`DREAM COMPLETE (empty) -- all sessions were trivial`);
      store.markSessionsProcessed(unprocessed, runId);
      store.setDreamState("last_dream_at", new Date().toISOString());
      store.setDreamState("last_dream_result", "success_empty");
      store.releaseDreamLock(pid);
      return { success: true, runId, sessionsProcessed: unprocessed.length, memoryChanges: emptyChanges(), journalPath: null };
    }

    // Prepare chain directory
    ui.setStatus("pi-memory", `🌙 Dream: preparing context...`);
    const chainDir = join(tmpdir(), `pi-dream-${runId.slice(0, 8)}`);
    mkdirSync(chainDir, { recursive: true });
    mkdirSync(DREAM_SESSIONS_DIR, { recursive: true });
    const meta = prepareChainDir(chainDir, sessions, store, config, runId);
    dreamLog(`PREP chain_dir=${chainDir} skills=selected projects=${meta.projects.join(",")}`);

    // Stage 1: Mine sessions
    ui.setStatus("pi-memory", `🌙 Dream: mining ${sessions.length} sessions...`);
    dreamLog(`MINE START ${sessions.length} sessions, model=${config.minerModel}`);
    const { extracted, minedPaths } = await runMiningStage(chainDir, config, exec);
    dreamLog(`MINE DONE extracted ${extracted.length} chars of raw results, ${minedPaths.length}/${sessions.length} sessions mined successfully`);

    // Post-MINE: deduplicate and count candidates across batches
    enrichCandidatesWithProvenance(extracted, chainDir);

    // If mining produced nothing, skip refine/advise
    if (extracted.length === 0) {
      dreamLog(`MINE produced no output -- skipping refine/advise stages`);
      const trivialPaths = unprocessed.filter(f => !sessions.some(s => s.path === f));
      if (trivialPaths.length > 0) {
        store.markSessionsProcessed(trivialPaths, runId);
        dreamLog(`MARK ${trivialPaths.length} trivial sessions as processed, ${unprocessed.length - trivialPaths.length} deferred`);
      } else {
        dreamLog(`MARK 0 sessions processed, all ${unprocessed.length} deferred`);
      }
      store.setDreamState("last_dream_at", new Date().toISOString());
      store.setDreamState("last_dream_result", "mining_failed");
      store.releaseDreamLock(pid);
      return { success: false, runId, sessionsProcessed: 0, memoryChanges: emptyChanges(), journalPath: null, error: "All mining batches failed -- sessions deferred for retry" };
    }

    // Stage 2: Refine memory (with tools for iterative exploration)
    ui.setStatus("pi-memory", `🌙 Dream: refining memory...`);
    dreamLog(`REFINE START model=${config.refinerModel}`);
    const refinement = await runRefinementStage(chainDir, config, exec, config.journalDir);
    const operations = refinement.operations;
    dreamLog(`REFINE DONE ${operations.length} operations produced`);

    // Stage 3: Workflow insights
    ui.setStatus("pi-memory", `🌙 Dream: analyzing workflow...`);
    dreamLog(`ADVISE START model=${config.advisorModel}`);
    const workflowInsights = await runAdvisorStage(chainDir, config, exec);
    dreamLog(`ADVISE DONE ${typeof workflowInsights === "string" ? workflowInsights.length + " chars" : workflowInsights.length + " insights"}`);

    // Apply operations to store
    ui.setStatus("pi-memory", `🌙 Dream: applying changes...`);
    const changeStats = applyOperations(store, operations);
    dreamLog(`APPLY ${operations.length} operations -> +${changeStats.added} added, ~${changeStats.updated} updated, =${changeStats.merged} merged, -${changeStats.deleted} deleted, +${changeStats.lessonsAdded} lessons`);

    // Safety check: abort if >50% reduction
    const stats = store.stats();
    const preDreamFacts = JSON.parse(readFileSync(join(chainDir, "current-memory.json"), "utf-8")).stats.factCount;
    if (stats.semantic < preDreamFacts * 0.5 && preDreamFacts > 10) {
      dreamLog(`SAFETY ABORT -- memory dropped from ${preDreamFacts} to ${stats.semantic} facts (>50% reduction)`);
      store.setDreamState("last_dream_at", new Date().toISOString());
      store.setDreamState("last_dream_result", "safety_abort");
      store.releaseDreamLock(pid);
      return { success: false, runId, sessionsProcessed: sessions.length, memoryChanges: changeStats, journalPath: null, error: "Safety abort: >50% memory reduction" };
    }

    // Write dream journal
    const journalInput: DreamJournalInput = {
      runId,
      timestamp: new Date(),
      sessionsProcessed: sessions.length,
      projectsCovered: meta.projects,
      dateRange: meta.dateRange,
      memoryChanges: buildJournalChanges(operations),
      pinSuggestions: refinement.pinSuggestions.length > 0 ? refinement.pinSuggestions : undefined,
      workflowInsights,
    };
    const journalPath = writeDreamJournal(config.journalDir, journalInput);

    // Update dream state
    const totalDreams = parseInt(store.getDreamState("total_dreams") || "0", 10) + 1;
    store.setDreamState("last_dream_at", new Date().toISOString());
    store.setDreamState("total_dreams", String(totalDreams));
    store.setDreamState("last_dream_result", "success");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    dreamLog(`JOURNAL wrote ${journalPath}`);

    // Mark only successfully mined sessions + trivial sessions as processed
    const trivialPaths = unprocessed.filter(f => !sessions.some(s => s.path === f));
    const minedPathSet = new Set(minedPaths);
    const processedPaths = [...trivialPaths, ...unprocessed.filter(f => minedPathSet.has(f))];
    const deferredCount = unprocessed.length - processedPaths.length;
    store.markSessionsProcessed(processedPaths, runId);
    dreamLog(`MARK ${processedPaths.length} sessions as processed (${trivialPaths.length} trivial + ${minedPaths.length} mined), ${deferredCount} deferred from failed batches`);
    dreamLog(`DREAM COMPLETE ${sessions.length} sessions processed in ${elapsed}s -- +${changeStats.added} facts, ~${changeStats.merged} merged, +${changeStats.lessonsAdded} lessons`);

    store.releaseDreamLock(pid);
    ui.notify(
      `Dream complete: +${changeStats.added} facts, ~${changeStats.merged} merged, ${changeStats.lessonsAdded} lessons. Journal: ${journalPath}`,
      "info"
    );

    return {
      success: true,
      runId,
      sessionsProcessed: sessions.length,
      memoryChanges: changeStats,
      journalPath,
    };
  } catch (err: any) {
    dreamLogError("DREAM", err);
    dreamLog(`DREAM FAILED run=${runId.slice(0, 8)} after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    try { store.setDreamState("last_dream_at", new Date().toISOString()); } catch {}
    try { store.setDreamState("last_dream_result", "failed"); } catch {}
    try { store.releaseDreamLock(pid); } catch {}

    ui.notify(`Dream failed: ${err.message?.slice(0, 100) || "unknown error"}`, "error");

    return { success: false, runId, sessionsProcessed: 0, memoryChanges: emptyChanges(), journalPath: null, error: err.message };
  } finally {
    ui.setStatus("pi-memory", "");
  }
}

// ─── Stage 1: Mining (pi --print, parallel batches) ──────────────────

interface MiningResult {
  extracted: string;
  minedPaths: string[];
}

async function runMiningStage(
  chainDir: string,
  config: DreamConfig,
  exec: ExecFn
): Promise<MiningResult> {
  const sessionsDir = join(chainDir, "sessions");
  const batches = readdirSync(sessionsDir).filter((f: string) => f.startsWith("batch-"));

  dreamLog(`MINE launching ${batches.length} batches in parallel`);

  // Prepare all batch prompts
  const batchMeta: Array<{ index: number; entries: { path: string }[]; promptFile: string; sizeKB: string }> = [];
  for (let i = 0; i < batches.length; i++) {
    const batchContent = readFileSync(join(sessionsDir, batches[i]), "utf-8");
    const batchEntries = JSON.parse(batchContent) as { path: string }[];
    const prompt = buildMinerPrompt(batchContent);
    const promptFile = join(chainDir, `miner-prompt-${i}.md`);
    writeFileSync(promptFile, prompt, "utf-8");
    const sizeKB = (batchContent.length / 1024).toFixed(0);
    batchMeta.push({ index: i, entries: batchEntries, promptFile, sizeKB });
    dreamLog(`MINE batch ${i + 1}/${batches.length} (${batchEntries.length} sessions, ${sizeKB}KB) -> queued`);
  }

  // Run all batches in parallel
  const startMs = Date.now();
  const batchResults = await Promise.allSettled(
    batchMeta.map(({ promptFile }) =>
      exec("pi", [
        "--print",
        "--no-extensions",
        "--session-dir", DREAM_SESSIONS_DIR,
        "--model", config.minerModel,
        `@${promptFile}`,
      ], { timeout: 900_000 })
    )
  );
  const totalElapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  // Collect results
  const results: string[] = [];
  const minedPaths: string[] = [];

  for (let i = 0; i < batchResults.length; i++) {
    const settled = batchResults[i];
    const meta = batchMeta[i];

    if (settled.status === "rejected") {
      dreamLog(`MINE batch ${i + 1}/${batches.length} REJECTED (${settled.reason}) -- ${meta.entries.length} sessions deferred`);
      continue;
    }

    const result = settled.value;
    if (result.code === 0 && result.stdout) {
      results.push(result.stdout);
      for (const entry of meta.entries) {
        minedPaths.push(entry.path);
      }
      dreamLog(`MINE batch ${i + 1}/${batches.length} done (${result.stdout.length} chars output)`);
    } else {
      dreamLog(`MINE batch ${i + 1}/${batches.length} FAILED (code=${result.code}, stderr=${result.stderr?.slice(0, 200) || "none"}) -- ${meta.entries.length} sessions deferred`);
    }
  }

  dreamLog(`MINE all batches complete in ${totalElapsed}s`);

  // Combine all extracted results
  const combined = results.join("\n");
  writeFileSync(join(chainDir, "extracted.json"), combined, "utf-8");
  return { extracted: combined, minedPaths };
}

// ─── Stage 2: Refinement (pi --print --tools, iterative) ─────────────

async function runRefinementStage(
  chainDir: string,
  config: DreamConfig,
  exec: ExecFn,
  journalDir?: string
): Promise<ParsedRefinement> {
  const extracted = safeReadFile(join(chainDir, "extracted.json"));
  const memory = safeReadFile(join(chainDir, "current-memory.json"));
  const skills = safeReadFile(join(chainDir, "skills.md"));
  const recentChanges = buildRecentChangesSummary(journalDir);

  const prompt = buildRefinerPrompt(extracted, memory, skills, recentChanges);
  dreamLog(`REFINE prompt size: ${(prompt.length / 1024).toFixed(0)}KB`);

  // Write prompt to file to avoid E2BIG (ARG_MAX ~1MB on macOS)
  const promptFile = join(chainDir, "refiner-prompt.md");
  writeFileSync(promptFile, prompt, "utf-8");

  const startMs = Date.now();
  // REFINE uses --tools so the model can search memory, read skills, and verify
  // before producing operations. This gives it iterative exploration capability.
  const result = await exec("pi", [
    "--print",
    "--tools", "read,ls,grep,find",
    "--no-extensions",
    "--session-dir", DREAM_SESSIONS_DIR,
    "--model", config.refinerModel,
    `@${promptFile}`,
  ], { timeout: 900_000 });

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  if (result.code !== 0 || !result.stdout) {
    dreamLog(`REFINE FAILED (${elapsedS}s, code=${result.code}, stderr=${result.stderr?.slice(0, 300) || "none"})`);
    return { operations: [], pinSuggestions: [] };
  }

  dreamLog(`REFINE response received (${elapsedS}s, ${result.stdout.length} chars)`);
  const parsed = parseOperations(result.stdout);
  if (parsed.operations.length === 0 && result.stdout.length > 50) {
    dreamLog(`REFINE WARNING: got ${result.stdout.length} chars but parsed 0 operations. First 200 chars: ${result.stdout.slice(0, 200)}`);
  }
  if (parsed.pinSuggestions.length > 0) {
    dreamLog(`REFINE pin suggestions: ${parsed.pinSuggestions.map(s => s.key).join(", ")}`);
  }
  return parsed;
}

// ─── Stage 3: Workflow Advisor (pi --print) ──────────────────────────

async function runAdvisorStage(
  chainDir: string,
  config: DreamConfig,
  exec: ExecFn
): Promise<string | WorkflowInsight[]> {
  const memory = safeReadFile(join(chainDir, "current-memory.json"));
  const skills = safeReadFile(join(chainDir, "skills.md"));
  const skillsListing = safeReadFile(join(chainDir, "skills-listing.md"));

  // Build session summary for workflow analysis
  const sessionsDir = join(chainDir, "sessions");
  const batches = readdirSync(sessionsDir).filter((f: string) => f.startsWith("batch-"));
  const summaries: string[] = [];
  for (const batch of batches) {
    const data = JSON.parse(readFileSync(join(sessionsDir, batch), "utf-8"));
    for (const session of data) {
      summaries.push(`[${session.project}] ${session.timestamp}: ${session.toolSummary}`);
    }
  }

  // Include the full skills listing so the advisor knows what exists
  const skillsContext = skillsListing
    ? `${skills}\n\n${skillsListing}`
    : skills;

  const prompt = buildAdvisorPrompt(summaries.join("\n"), memory, skillsContext);
  dreamLog(`ADVISE prompt size: ${(prompt.length / 1024).toFixed(0)}KB`);

  // Write prompt to file to avoid E2BIG (ARG_MAX ~1MB on macOS)
  const promptFile = join(chainDir, "advisor-prompt.md");
  writeFileSync(promptFile, prompt, "utf-8");

  const startMs = Date.now();
  const result = await exec("pi", [
    "--print",
    "--no-extensions",
    "--session-dir", DREAM_SESSIONS_DIR,
    "--model", config.advisorModel,
    `@${promptFile}`,
  ], { timeout: 900_000 });

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  if (result.code !== 0) {
    dreamLog(`ADVISE FAILED (${elapsedS}s, code=${result.code}, stderr=${result.stderr?.slice(0, 200) || "none"})`);
    return "";
  }
  dreamLog(`ADVISE response received (${elapsedS}s, ${result.stdout?.length || 0} chars)`);
  return result.stdout || "";
}

// ─── Result Application ──────────────────────────────────────────────

function applyOperations(store: MemoryStore, operations: MemoryOperation[]): DreamResult["memoryChanges"] {
  const changes = emptyChanges();

  for (const op of operations) {
    try {
      switch (op.type) {
        case "add":
          if (op.key && op.value) {
            store.setSemantic(op.key, op.value, op.confidence ?? 0.85, "consolidation");
            changes.added++;
          }
          break;

        case "update":
          if (op.key && op.value) {
            store.setSemantic(op.key, op.value, op.confidence ?? 0.9, "consolidation");
            changes.updated++;
          }
          break;

        case "merge":
          if (op.mergeKeys && op.into && op.value) {
            // Preserve pin if any of the merged keys were pinned
            const wasPinned = op.mergeKeys.some(k => {
              const entry = store.getSemantic(k);
              return entry?.pinned === 1;
            });
            for (const k of op.mergeKeys) {
              store.deleteSemantic(k);
            }
            store.setSemantic(op.into, op.value, op.confidence ?? 0.9, "consolidation");
            if (wasPinned) {
              store.pin(op.into);
            }
            changes.merged++;
          }
          break;

        case "delete":
          if (op.key) {
            // Never delete pinned facts — they are user-intentional
            const entry = store.getSemantic(op.key);
            if (entry?.pinned === 1) {
              // Skip — pinned facts are protected from Dream deletion
              break;
            }
            store.deleteSemantic(op.key);
            changes.deleted++;
          }
          break;

        case "add_lesson":
          if (op.rule) {
            const result = store.addLesson(op.rule, op.category ?? "general", "dream", op.negative ?? false);
            if (result.success) changes.lessonsAdded++;
          }
          break;

        case "delete_lesson":
          if (op.rule_substring) {
            const lessons = store.listLessons(undefined, 500);
            const match = lessons.find(l =>
              l.rule.toLowerCase().includes(op.rule_substring!.toLowerCase())
            );
            if (match) {
              store.deleteLesson(match.id);
              changes.lessonsDeleted++;
            }
          }
          break;
      }
    } catch {
      // Skip invalid operations
    }
  }

  return changes;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Enrich MINE output with provenance (confirmedIn counts).
 * Deduplicates candidates across batches.
 */
function enrichCandidatesWithProvenance(extracted: string, chainDir: string): string {
  try {
    const data = JSON.parse(extracted);
    if (!data.semantic && !data.lessons) return extracted;

    // Dedup semantic facts by key, counting occurrences
    const keyMap = new Map<string, { value: string; confidence: number; confirmedIn: number }>();
    for (const fact of (data.semantic ?? [])) {
      const existing = keyMap.get(fact.key);
      if (existing) {
        existing.confirmedIn++;
        if (fact.confidence > existing.confidence) {
          existing.value = fact.value;
          existing.confidence = fact.confidence;
        }
      } else {
        keyMap.set(fact.key, { value: fact.value, confidence: fact.confidence, confirmedIn: 1 });
      }
    }

    // Dedup lessons by rule similarity (exact match)
    const lessonMap = new Map<string, { rule: string; category: string; negative: boolean; confirmedIn: number }>();
    for (const lesson of (data.lessons ?? [])) {
      const normRule = lesson.rule.toLowerCase().trim();
      const existing = lessonMap.get(normRule);
      if (existing) {
        existing.confirmedIn++;
      } else {
        lessonMap.set(normRule, { rule: lesson.rule, category: lesson.category, negative: lesson.negative, confirmedIn: 1 });
      }
    }

    const enriched = {
      semantic: [...keyMap.entries()].map(([key, v]) => ({ key, ...v })),
      lessons: [...lessonMap.values()],
    };

    const enrichedJson = JSON.stringify(enriched, null, 2);
    writeFileSync(join(chainDir, "extracted.json"), enrichedJson, "utf-8");
    return enrichedJson;
  } catch {
    // Not parseable as JSON (shell-out path produces free text)
    return extracted;
  }
}

/**
 * Build a summary of the most recent dream's operations so REFINE doesn't re-process.
 */
function buildRecentChangesSummary(journalDir?: string): string | undefined {
  if (!journalDir) return undefined;

  try {
    const files = readdirSync(journalDir)
      .filter((f: string) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (const file of files.slice(0, 3)) {
      const content = readFileSync(join(journalDir, file), "utf-8");
      const changesMatch = content.match(/### Memory Changes\n([\s\S]*?)(?=###|---\s*$|$)/);
      if (changesMatch && changesMatch[1].trim().length > 20) {
        const changes = changesMatch[1].trim();
        if (changes.length > 1500) {
          return changes.slice(0, 1500) + "\n[... truncated]";
        }
        return changes;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function emptyChanges(): DreamResult["memoryChanges"] {
  return { added: 0, updated: 0, merged: 0, deleted: 0, lessonsAdded: 0, lessonsDeleted: 0 };
}

interface ParsedRefinement {
  operations: MemoryOperation[];
  pinSuggestions: Array<{ key: string; reason: string }>;
}

function parseOperations(text: string): ParsedRefinement {
  // Extract JSON from response (may be in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { operations: [], pinSuggestions: [] };

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const operations = Array.isArray(parsed.operations)
      ? parsed.operations.filter((op: any) =>
          op && typeof op.type === "string" && typeof op.reason === "string"
        )
      : [];
    const pinSuggestions = Array.isArray(parsed.pin_suggestions)
      ? parsed.pin_suggestions.filter((s: any) =>
          s && typeof s.key === "string" && typeof s.reason === "string"
        )
      : [];
    return { operations, pinSuggestions };
  } catch {
    return { operations: [], pinSuggestions: [] };
  }
}

function buildJournalChanges(operations: MemoryOperation[]): DreamJournalInput["memoryChanges"] {
  const changes: DreamJournalInput["memoryChanges"] = {
    added: [], updated: [], merged: [], deleted: [],
    lessonsAdded: [], lessonsDeleted: [],
  };

  for (const op of operations) {
    switch (op.type) {
      case "add":
        if (op.key && op.value) changes.added.push({ key: op.key, value: op.value });
        break;
      case "update":
        if (op.key && op.value) changes.updated.push({ key: op.key, value: op.value, reason: op.reason });
        break;
      case "merge":
        if (op.mergeKeys && op.into && op.value) changes.merged.push({ from: op.mergeKeys, into: op.into, value: op.value });
        break;
      case "delete":
        if (op.key) changes.deleted.push({ key: op.key, reason: op.reason });
        break;
      case "add_lesson":
        if (op.rule) changes.lessonsAdded.push({ rule: op.rule, category: op.category ?? "general" });
        break;
      case "delete_lesson":
        if (op.rule_substring) changes.lessonsDeleted.push({ rule: op.rule_substring, reason: op.reason });
        break;
    }
  }

  return changes;
}

function safeReadFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}
