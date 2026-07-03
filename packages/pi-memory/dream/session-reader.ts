/**
 * dream/session-reader.ts — Parse pi session JSONL files into extractable content.
 *
 * Handles the session format:
 * - type: "message" with role user/assistant/toolResult
 * - Skips encrypted thinking blocks (thinkingSignature)
 * - Aggressively filters tool results (keeps errors, skips file dumps)
 * - Extracts tool call summaries for workflow analysis
 * - Caps per-session output at ~4000 tokens
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { MemoryStore } from "../store.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolCallSummary {
  name: string;
  success: boolean;
  brief: string;  // first 100 chars of non-file result
}

export interface ExtractedSession {
  path: string;
  project: string;
  timestamp: string;
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: ToolCallSummary[];
  estimatedTokens: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_SESSION_TOKENS = 4000;
const CHARS_PER_TOKEN = 4; // rough approximation
const MAX_SESSION_CHARS = MAX_SESSION_TOKENS * CHARS_PER_TOKEN;

/** Tool results that are almost always file contents — skip these */
const FILE_CONTENT_TOOLS = new Set([
  "read", "find", "ls", "grep", "bash_readonly", "fetch_content", "get_search_content",
]);

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Find all session JSONL files across all project directories.
 * Handles both flat .jsonl files and nested session.jsonl in subagent dirs.
 */
export function findAllSessionFiles(sessionsDir: string): string[] {
  const files: string[] = [];

  try {
    const projectDirs = readdirSync(sessionsDir);

    for (const projectDir of projectDirs) {
      // Skip dream-related session directories (old runs before --session-dir fix)
      if (projectDir.startsWith("pi-dream") || projectDir === "dream-sessions") continue;

      const projectPath = join(sessionsDir, projectDir);
      try {
        const stat = statSync(projectPath);
        if (!stat.isDirectory()) continue;
      } catch { continue; }

      // Scan for .jsonl files (flat session files)
      try {
        const entries = readdirSync(projectPath);
        for (const entry of entries) {
          if (entry.endsWith(".jsonl")) {
            files.push(join(projectPath, entry));
          } else {
            // Check for nested session dirs (subagent sessions: hash/run-N/session.jsonl)
            const nestedPath = join(projectPath, entry);
            try {
              if (statSync(nestedPath).isDirectory()) {
                findNestedSessionFiles(nestedPath, files);
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch {
    // sessionsDir doesn't exist
  }

  return files.sort();
}

/**
 * Filter out sessions that have already been processed.
 */
export function filterUnprocessed(files: string[], store: MemoryStore): string[] {
  return files.filter(f => !store.isSessionProcessed(f));
}

/**
 * Parse a single session JSONL file into structured extractable content.
 */
export function parseSessionJSONL(filePath: string): ExtractedSession {
  const project = deriveProject(filePath);
  const timestamp = deriveTimestamp(filePath);
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: ToolCallSummary[] = [];

  let lines: string[];
  try {
    lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  } catch {
    return { path: filePath, project, timestamp, userMessages: [], assistantMessages: [], toolCalls: [], estimatedTokens: 0 };
  }

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role;

    if (role === "user") {
      const text = extractText(msg.content);
      if (text && text.length > 3) {
        userMessages.push(text);
      }
    } else if (role === "assistant") {
      const text = extractAssistantText(msg.content);
      if (text && text.length > 3) {
        assistantMessages.push(text);
      }
      // Extract tool calls from assistant messages
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") {
            toolCalls.push({
              name: block.name || "unknown",
              success: true, // assume success; updated when toolResult arrives
              brief: truncate(JSON.stringify(block.arguments || {}), 100),
            });
          }
        }
      }
    } else if (role === "toolResult") {
      // Update last tool call with success/fail info
      const isError = !!msg.isError;
      const toolName = msg.toolName || "";
      const text = extractText(msg.content);

      // Update the corresponding tool call entry
      if (toolCalls.length > 0) {
        const lastCall = toolCalls[toolCalls.length - 1];
        if (lastCall.name === toolName || lastCall.success === true) {
          lastCall.success = !isError;
        }
      }

      // Keep error messages (valuable for learning)
      if (isError && text) {
        assistantMessages.push(`[Tool Error: ${toolName}] ${truncate(text, 200)}`);
      }
      // For non-file tools, keep a brief result
      else if (text && !FILE_CONTENT_TOOLS.has(toolName) && text.length < 500) {
        // Likely a meaningful tool result (memory_search, web_search summary, etc.)
        toolCalls.push({
          name: toolName,
          success: true,
          brief: truncate(text, 100),
        });
      }
    }
  }

  // Apply token cap: truncate from middle if too long
  const allText = [...userMessages, ...assistantMessages].join("\n");
  const estimatedTokens = Math.ceil(allText.length / CHARS_PER_TOKEN);

  if (allText.length > MAX_SESSION_CHARS) {
    return capSession({ path: filePath, project, timestamp, userMessages, assistantMessages, toolCalls, estimatedTokens });
  }

  return { path: filePath, project, timestamp, userMessages, assistantMessages, toolCalls, estimatedTokens };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function findNestedSessionFiles(dir: string, files: string[]): void {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "session.jsonl") {
        files.push(full);
      } else {
        try {
          if (statSync(full).isDirectory()) {
            findNestedSessionFiles(full, files);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

function deriveProject(filePath: string): string {
  // Path pattern: sessions/--Users-user-Dev-project-name--/...
  const parts = filePath.split("/");
  for (const part of parts) {
    if (part.startsWith("--") && part.endsWith("--")) {
      // Extract last meaningful segment from the path encoding
      const segments = part.slice(2, -2).split("-").filter(Boolean);
      // Skip common path prefixes
      const skip = new Set(["users", "user", "dev", "home", "workplace", "local", "src", "private", "var", "folders", "tmp"]);
      const meaningful = segments.filter(s => !skip.has(s.toLowerCase()) && s.length > 1);
      return meaningful[meaningful.length - 1]?.toLowerCase() || "unknown";
    }
  }
  return "unknown";
}

function deriveTimestamp(filePath: string): string {
  // Filename pattern: 2026-04-28T13-26-28-441Z_uuid.jsonl
  const name = basename(filePath);
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : "unknown";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Extract text from assistant content, skipping encrypted thinking blocks.
 */
function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((c: any) => {
      // Skip thinking/thinkingSignature blocks
      if (c.type === "thinking" || c.type === "thinkingSignature") return false;
      return c.type === "text" && typeof c.text === "string";
    })
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * Cap session content to MAX_SESSION_CHARS by keeping start and end,
 * truncating from the middle.
 */
function capSession(session: ExtractedSession): ExtractedSession {
  const halfBudget = Math.floor(MAX_SESSION_CHARS / (2 * CHARS_PER_TOKEN));

  // Keep first N and last N messages
  const allUser = session.userMessages;
  const allAssistant = session.assistantMessages;

  if (allUser.length > halfBudget / 50) { // rough: ~50 chars per message avg
    const keep = Math.max(3, Math.floor(allUser.length / 3));
    session.userMessages = [
      ...allUser.slice(0, keep),
      "[... middle truncated ...]",
      ...allUser.slice(-keep),
    ];
  }

  if (allAssistant.length > halfBudget / 100) {
    const keep = Math.max(3, Math.floor(allAssistant.length / 3));
    session.assistantMessages = [
      ...allAssistant.slice(0, keep),
      "[... middle truncated ...]",
      ...allAssistant.slice(-keep),
    ];
  }

  return session;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
