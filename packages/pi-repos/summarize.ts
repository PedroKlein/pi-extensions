/**
 * pi-repos — TL;DR generation and repos_info logic.
 *
 * Strategy:
 * 1. Spawn `pi --print` with read-only tools + focused system prompt
 * 2. Prioritize README.md + AGENTS.md as primary context
 * 3. LLM explores the repo itself (reads files, follows structure)
 * 4. Store: tldr.md (≤10 lines), summary.md, rev.txt
 *
 * All LLM work is background/async; structural fallback if pi binary unavailable.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoEntry, ReposConfig, InfoOutput, Summary, FreshnessInfo, RepoGroup } from "./types.js";
import { loadIndex, saveIndex, resolveRepo, repoMetaDir, readSummary, writeTldr, writeSummary, readAnnotations } from "./storage.js";
import { getPaths } from "./config.js";

const execFile = promisify(execFileCb);

// ─── System Prompt ───────────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = `You summarize code repositories. You have read-only access to the filesystem.

Your job:
1. Explore the repository at the given path (read key files, check structure)
2. Produce a clear, concise summary

Focus on: what it does, key technologies, architecture patterns, and notable conventions.
Do NOT produce preamble or meta-commentary — only the summary content itself.`;

// ─── Head Resolution ─────────────────────────────────────────────────────────

/**
 * Get current HEAD SHA for a repo entry.
 * Uses the first worktree for cloned repos, the repo path for local.
 */
async function resolveHead(entry: RepoEntry): Promise<string> {
  const gitCwd = entry.type === "local"
    ? entry.path
    : (entry.worktrees.length > 0 ? entry.worktrees[0].path : entry.path);

  try {
    const { stdout } = await execFile("git", ["-C", gitCwd, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Return the primary search/analysis path for a repo. */
function primaryPath(entry: RepoEntry): string {
  if (entry.type === "local") return entry.path;
  return entry.worktrees.length > 0 ? entry.worktrees[0].path : entry.path;
}

// ─── Primary Context Reading ─────────────────────────────────────────────────

/**
 * Read README.md and AGENTS.md from the repo if they exist.
 * Returns their content (capped) for inclusion in the TL;DR prompt.
 */
function readPrimaryContext(repoPath: string): string {
  const sections: string[] = [];
  const maxPerFile = 4000;

  for (const name of ["README.md", "README.rst", "README"]) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) {
        sections.push(`## README\n\n${content.slice(0, maxPerFile)}`);
      }
      break;
    }
  }

  const agentsPath = join(repoPath, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf-8").trim();
    if (content) {
      sections.push(`## AGENTS.md\n\n${content.slice(0, maxPerFile)}`);
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : "";
}

// ─── TL;DR Output Parsing ────────────────────────────────────────────────────

const VALID_TYPES = new Set([
  "library", "service", "cli", "config", "infra", "framework",
  "plugin", "academic", "monorepo", "toolkit", "docs", "other",
]);

/**
 * Parse the TL;DR output: extract the paragraph and the TYPE: tag.
 * The last line should be "TYPE: <tag>".
 */
function parseTldrOutput(raw: string): { tldr: string; typeTag: string | null } {
  const lines = raw.trim().split("\n");
  let typeTag: string | null = null;

  // Check last few lines for TYPE: pattern (LLM may add trailing whitespace)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const match = lines[i].match(/^\s*TYPE:\s*(.+)$/i);
    if (match) {
      const candidate = match[1].trim().toLowerCase();
      if (VALID_TYPES.has(candidate)) {
        typeTag = candidate;
      }
      lines.splice(i, 1);
      break;
    }
  }

  const tldr = lines.slice(0, 10).join("\n").trim();
  return { tldr, typeTag };
}

/** Add a type tag to the repo's autoTags in the index if not already present. */
function updateAutoTag(config: ReposConfig, entry: RepoEntry, typeTag: string): void {
  try {
    const index = loadIndex(config);
    const idx = index.repos.findIndex(
      r => r.host === entry.host && r.owner === entry.owner && r.name === entry.name,
    );
    if (idx >= 0 && !index.repos[idx].autoTags.includes(typeTag)) {
      index.repos[idx].autoTags.push(typeTag);
      saveIndex(config, index);
    }
  } catch { /* best-effort */ }
}

// ─── Adaptive Summary Prompts ────────────────────────────────────────────────

const SUMMARY_FOCUS: Record<string, string> = {
  library: [
    "- Main exports and public API surface (key functions, types, classes)",
    "- Installation and usage patterns (how a consumer would use this)",
    "- Configuration options and defaults",
    "- Dependencies and peer dependencies",
  ].join("\n"),
  service: [
    "- API endpoints and their purpose",
    "- Authentication and authorization model",
    "- Data stores and external service dependencies",
    "- Configuration and environment variables",
    "- Deployment and runtime requirements",
  ].join("\n"),
  cli: [
    "- Available commands and subcommands with brief descriptions",
    "- Key flags and options",
    "- Configuration file format (if any)",
    "- Installation method",
  ].join("\n"),
  config: [
    "- What system/service this configures",
    "- Schema and key fields",
    "- Environment/variant structure",
    "- Validation rules",
  ].join("\n"),
  infra: [
    "- Resources provisioned and their relationships",
    "- Environments and regions covered",
    "- Secret management approach",
    "- GitOps reconciliation model",
    "- Provider dependencies (Crossplane, Terraform, Helm, etc.)",
  ].join("\n"),
  plugin: [
    "- What host system this extends",
    "- Features and capabilities provided",
    "- Configuration and setup",
    "- API hooks and extension points used",
  ].join("\n"),
  framework: [
    "- Core abstractions and programming model",
    "- Extension/plugin system",
    "- Key APIs for consumers",
    "- Conventions and constraints",
  ].join("\n"),
  academic: [
    "- Research question or thesis",
    "- Methodology and tools",
    "- Key findings or contributions",
    "- Technologies and data sources",
  ].join("\n"),
};

const DEFAULT_SUMMARY_FOCUS = [
  "- Purpose and what problem it solves",
  "- Architecture overview and key modules",
  "- Technologies and dependencies",
  "- Usage patterns and conventions",
].join("\n");

/**
 * Build an adaptive summary prompt based on detected repo type.
 * Two-pass approach: the prompt instructs the LLM to first identify key files,
 * then produce the summary focused on consumer-relevant information.
 */
function buildAdaptiveSummaryPrompt(
  repoLabel: string,
  repoPath: string,
  detectedType: string | null,
  autoTags: string[],
): string {
  // Determine which focus to use
  const type = detectedType ?? autoTags.find(t => t in SUMMARY_FOCUS) ?? null;
  const focus = type && SUMMARY_FOCUS[type] ? SUMMARY_FOCUS[type] : DEFAULT_SUMMARY_FOCUS;

  return (
    `Produce a structured markdown summary of the repository "${repoLabel}" at path: ${repoPath}\n\n` +
    `APPROACH: First identify the most important files (README, main entry points, exports, manifests, config). ` +
    `Read those files to understand what this repo provides. Then produce the summary.\n\n` +
    `Focus your summary on:\n${focus}\n\n` +
    `Write from the perspective of someone who needs to USE or CONSUME this repo, not maintain it internally.\n` +
    `Be concise but thorough (200-500 words). Output ONLY the summary markdown.`
  );
}

// ─── pi --print Subprocess ───────────────────────────────────────────────────

/**
 * Run `pi --print --no-extensions --system-prompt <prompt> --model <model> <user_prompt>`.
 * Returns trimmed stdout, or null on error / timeout.
 */
async function runPiPrint(model: string | undefined, systemPrompt: string, userPrompt: string): Promise<string | null> {
  const args = [
    "--print",
    "--no-extensions",
    "--system-prompt", systemPrompt,
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push(userPrompt);

  return new Promise(resolve => {
    let out = "";
    let resolved = false;
    let child: ReturnType<typeof spawn>;
    try {
      // detached: false ensures child is in our process group for cleanup
      child = spawn("pi", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }

    const done = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", code => done(code === 0 && out.trim().length > 0 ? out.trim() : null));
    child.on("error", () => done(null));

    // 3-minute timeout — SIGKILL to ensure no orphans
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(null);
    }, 180_000);

    child.on("close", () => clearTimeout(timer));
  });
}

// ─── Structural Fallback ─────────────────────────────────────────────────────

/**
 * Build a minimal structural TL;DR without LLM (when pi binary is unavailable).
 * Returns a 5-line summary from manifest detection and README header.
 */
function structuralFallback(entry: RepoEntry, repoPath: string): string {
  const lines: string[] = [
    `Repository: ${entry.owner}/${entry.name}`,
    `Type: ${entry.type}`,
    `Path: ${entry.path}`,
  ];

  // Check for manifests
  const manifests = ["go.mod", "package.json", "Cargo.toml", "pyproject.toml", "pom.xml"];
  const found = manifests.filter(m => existsSync(join(repoPath, m)));
  if (found.length > 0) lines.push(`Stack: ${found.join(", ")}`);

  // Tags
  const tags = [...entry.tags, ...entry.autoTags];
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);

  // README first line
  for (const name of ["README.md", "README.rst", "README"]) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      const firstLine = readFileSync(p, "utf-8").split("\n").find(l => l.trim() && !l.startsWith("#"));
      if (firstLine) lines.push(firstLine.trim().slice(0, 120));
      break;
    }
  }

  return lines.join("\n");
}

// ─── Generate TL;DR ──────────────────────────────────────────────────────────

/**
 * Generate TL;DR + full summary for a repo and persist to metaDir.
 *
 * Strategy:
 * 1. Build prompt with repo path + primary context (README, AGENTS.md)
 * 2. Spawn `pi --print` with read-only tools to let LLM explore
 * 3. Fall back to structural if pi is unavailable
 */
export async function generateTldr(
  config: ReposConfig,
  entry: RepoEntry,
  metaDir: string,
): Promise<void> {
  mkdirSync(metaDir, { recursive: true });

  const repoPath = primaryPath(entry);
  const rev = await resolveHead(entry);
  const repoLabel = `${entry.owner}/${entry.name}`;

  // Build user prompt with primary context from README + AGENTS.md
  const primaryContext = readPrimaryContext(repoPath);
  let tldrPrompt = `Summarize the repository "${repoLabel}" at path: ${repoPath}\n\n`;
  tldrPrompt += `Explore the repository structure and key files to understand what it does.\n\n`;
  tldrPrompt += `Produce your response in EXACTLY this format:\n`;
  tldrPrompt += `1. A TL;DR paragraph (max 10 lines) covering: what it does, key technologies, notable patterns.\n`;
  tldrPrompt += `2. On the very last line, output ONLY a type classification tag in this format:\n`;
  tldrPrompt += `   TYPE: <one of: library, service, cli, config, infra, framework, plugin, academic, monorepo, toolkit, docs, other>\n\n`;
  tldrPrompt += `Output ONLY the TL;DR paragraph followed by the TYPE line — no preamble, no headers, no extra explanation.`;

  if (primaryContext) {
    tldrPrompt += `\n\nHere is key documentation from the repository:\n\n${primaryContext}`;
  }

  const tldrRaw = await runPiPrint(config.summaryModel, SUMMARIZER_SYSTEM_PROMPT, tldrPrompt);

  let detectedType: string | null = null;
  if (tldrRaw) {
    const { tldr, typeTag } = parseTldrOutput(tldrRaw);
    writeTldr(metaDir, tldr, rev);
    detectedType = typeTag;

    // Update autoTags with detected type if present
    if (typeTag) {
      updateAutoTag(config, entry, typeTag);
    }
  } else {
    // pi binary unavailable or timed out — write structural fallback
    writeTldr(metaDir, structuralFallback(entry, repoPath), rev);
  }

  // Full summary (two-pass, adaptive by repo type)
  const summaryPrompt = buildAdaptiveSummaryPrompt(repoLabel, repoPath, detectedType, entry.autoTags);
  const fullSummary = await runPiPrint(config.summaryModel, SUMMARIZER_SYSTEM_PROMPT, summaryPrompt);
  if (fullSummary) {
    writeSummary(metaDir, fullSummary);
  }
}

// ─── Staleness Check ─────────────────────────────────────────────────────────

/**
 * Return true if the stored rev.txt is older than the current HEAD.
 */
export async function checkStaleness(entry: RepoEntry, metaDir: string): Promise<boolean> {
  const revPath = join(metaDir, "rev.txt");
  if (!existsSync(revPath)) return true; // no summary yet — treat as stale

  const stored = readFileSync(revPath, "utf-8").trim();
  if (!stored) return true;

  const current = await resolveHead(entry);
  if (!current) return false; // can't determine HEAD; assume not stale

  return stored !== current;
}

// ─── repos_info ──────────────────────────────────────────────────────────────

/**
 * Get full details for a repo: entry, summary (with staleness), annotations, freshness.
 * If regenerate is true, re-generates TL;DR before returning.
 */
export async function getRepoInfo(
  config: ReposConfig,
  identifier: string,
  regenerate = false,
): Promise<InfoOutput> {
  const index = loadIndex(config);
  const entry = resolveRepo(index, identifier);
  const metaDir = repoMetaDir(config, entry);
  const notesPath = join(metaDir, "notes.md");

  if (regenerate) {
    await generateTldr(config, entry, metaDir);
  }

  // Read summary + staleness
  let summary: Summary | null = readSummary(metaDir);
  if (summary) {
    summary.stale = await checkStaleness(entry, metaDir);
  }

  const annotations = readAnnotations(notesPath);

  // Freshness derived from index entry
  const freshness: FreshnessInfo = {
    lastSync: entry.lastSyncedAt,
    commitsBehind: entry.commitsBehind,
    indexStale: summary?.stale ?? false,
  };

  return { entry, summary, annotations, freshness };
}

// ─── Group Documentation Generation ───────────────────────────────────────────

const GROUP_DOCS_SYSTEM_PROMPT = `You are a software architect documenting a system of related repositories.
Produce clear, concise technical documentation. No preamble or meta-commentary.
Output ONLY the requested content in markdown format.`;

interface GroupDocContext {
  group: RepoGroup;
  members: Array<{ id: string; tldr: string }>;
}

function buildGroupDocContext(config: ReposConfig, group: RepoGroup): GroupDocContext {
  const index = loadIndex(config);
  const members: Array<{ id: string; tldr: string }> = [];

  for (const memberId of group.repos) {
    let tldr = "";
    try {
      const entry = resolveRepo(index, memberId);
      const metaDir = repoMetaDir(config, entry);
      const summary = readSummary(metaDir);
      if (summary?.tldr) tldr = summary.tldr;
    } catch { /* skip */ }
    members.push({ id: memberId, tldr });
  }

  return { group, members };
}

function buildArchitecturePrompt(ctx: GroupDocContext): string {
  const memberBlock = ctx.members.map(m =>
    `### ${m.id}\n${m.tldr || "_No summary._"}`
  ).join("\n\n");

  const connBlock = ctx.group.connections.map(c =>
    `- ${c.from} --[${c.relationship}]--> ${c.to}${c.description ? ` (${c.description})` : ""}`
  ).join("\n") || "_None defined._";

  const refBlock = (ctx.group.references ?? []).map(r =>
    `- ${r.repo}${r.tag ? ` @${r.tag}` : ""}${r.reason ? ` — ${r.reason}` : ""}`
  ).join("\n") || "_None._";

  return `Generate an architecture document for the "${ctx.group.name}" system.

## Members

${memberBlock}

## Connections

${connBlock}

## Context References

${refBlock}

## Requirements

Produce a markdown document with these sections:
1. **Overview** — 2-3 sentences on what this system does end-to-end
2. **Data Flow** — How data/requests move through the system. Include reconciliation loops if applicable.
3. **Connections** — A table: | From | Relationship | To | Description |
4. **Key Integration Points** — Shared schemas, APIs, events, config formats between repos

Be specific to THIS system based on the TL;DRs. Do not be generic.`;
}

function buildRolesPrompt(ctx: GroupDocContext): string {
  const memberBlock = ctx.members.map(m =>
    `- **${m.id}**: ${m.tldr?.split("\n")[0] || "_No summary._"}`
  ).join("\n");

  return `For the "${ctx.group.name}" system, describe each repository's role.

## Members

${memberBlock}

## Requirements

For each member, produce:
- **Role**: 1-2 sentences on what this repo does in the context of the larger system
- **Owns**: What this repo is the source of truth for
- **Depends on**: Which other members it relies on and why

Format as a markdown list with repo ID as heading. Be specific, not generic.`;
}

function buildGlossaryPrompt(ctx: GroupDocContext): string {
  const memberBlock = ctx.members.map(m =>
    `${m.id}: ${m.tldr || ""}`
  ).join("\n");

  return `Extract a glossary of key technical terms from this system.

System: ${ctx.group.name}
Description: ${ctx.group.description || ""}

Member TL;DRs:
${memberBlock}

Produce a markdown glossary with:
- Term in **bold**
- Definition in 1-2 sentences, specific to this system's context
- Only include terms that are domain-specific or might be ambiguous

Format: | Term | Definition | (markdown table)
Aim for 10-20 terms. Skip generic programming terms.`;
}

function buildMapPrompt(ctx: GroupDocContext): string {
  const connBlock = ctx.group.connections.map(c => {
    const rel = c.relationship.replace(/-/g, " ");
    return `  ${sanitizeMermaidId(c.from)} -->|${rel}| ${sanitizeMermaidId(c.to)}`;
  }).join("\n");

  const memberList = ctx.members.map(m => `  ${sanitizeMermaidId(m.id)}["${m.id}"]`).join("\n");

  return `Generate a Mermaid dependency diagram for the "${ctx.group.name}" system.

Members:
${ctx.members.map(m => `- ${m.id}`).join("\n")}

Connections:
${ctx.group.connections.map(c => `- ${c.from} --[${c.relationship}]--> ${c.to}`).join("\n") || "_None_"}

Produce ONLY a valid mermaid graph (flowchart TD). Include:
- All members as nodes
- All connections as labeled edges
- Group related repos with subgraph if natural clusters exist

Example format:
\`\`\`mermaid
flowchart TD
${memberList}
${connBlock}
\`\`\`

Output ONLY the mermaid code block, no other text.`;
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Generate group documentation files: architecture.md, roles.md, glossary.md, map.md.
 * Writes to groups/{name}/docs/. Does NOT overwrite non-standard files.
 */
export async function generateGroupDocs(
  config: ReposConfig,
  groupName: string,
): Promise<{ generated: string[]; errors: string[] }> {
  const { getGroupInfo: getGroup } = await import("./group.js");
  const group = getGroup(config, groupName);
  const docsDir = join(getPaths(config).groups, groupName, "docs");
  mkdirSync(docsDir, { recursive: true });

  const ctx = buildGroupDocContext(config, group);
  const generated: string[] = [];
  const errors: string[] = [];

  const tasks: Array<{ file: string; prompt: string }> = [
    { file: "architecture.md", prompt: buildArchitecturePrompt(ctx) },
    { file: "roles.md", prompt: buildRolesPrompt(ctx) },
    { file: "glossary.md", prompt: buildGlossaryPrompt(ctx) },
    { file: "map.md", prompt: buildMapPrompt(ctx) },
  ];

  for (const task of tasks) {
    try {
      const result = await runPiPrint(config.summaryModel, GROUP_DOCS_SYSTEM_PROMPT, task.prompt);
      if (result) {
        writeFileSync(join(docsDir, task.file), result, "utf-8");
        generated.push(task.file);
      } else {
        errors.push(`${task.file}: LLM returned no output`);
      }
    } catch (err: any) {
      errors.push(`${task.file}: ${err.message}`);
    }
  }

  return { generated, errors };
}
