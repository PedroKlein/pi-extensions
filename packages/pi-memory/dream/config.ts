/**
 * dream/config.ts — Dream configuration resolution.
 *
 * Reads memory.dream from global and project settings.json with defaults.
 * Follows the same resolution pattern as the parent extension's readSettingsConfig().
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean;
  autoTrigger: boolean;
  minHoursSinceDream: number;
  minSessionsSinceDream: number;
  maxSessionsPerRun: number | null;
  minerModel: string;
  refinerModel: string;
  advisorModel: string;
  journalDir: string;
  sessionsDir: string;
  skillsDir: string;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DREAM_DEFAULTS: DreamConfig = {
  enabled: true,
  autoTrigger: true,
  minHoursSinceDream: 24,
  minSessionsSinceDream: 5,
  maxSessionsPerRun: null,
  minerModel: "github-copilot/gpt-5.4-mini",
  refinerModel: "github-copilot/claude-sonnet-4.6",
  advisorModel: "github-copilot/claude-sonnet-4.6",
  journalDir: join(homedir(), ".pi", "memory", "dream-journal"),
  sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
  skillsDir: join(homedir(), ".agents", "skills"),
};

// ─── Resolution ──────────────────────────────────────────────────────

/**
 * Read dream config from settings.json (global + project override).
 * Falls back to DREAM_DEFAULTS for any missing field.
 */
export function readDreamConfig(cwd?: string): DreamConfig {
  const config = { ...DREAM_DEFAULTS };

  // Read global settings
  const globalPath = join(homedir(), ".pi", "agent", "settings.json");
  applyFromFile(config, globalPath);

  // Read project settings (overrides global)
  if (cwd) {
    const projectPath = join(cwd, ".pi", "settings.json");
    applyFromFile(config, projectPath);
  }

  return config;
}

function applyFromFile(config: DreamConfig, filePath: string): void {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const settings = JSON.parse(raw);
    const dream = settings?.memory?.dream;
    if (!dream || typeof dream !== "object") return;

    if (typeof dream.enabled === "boolean") config.enabled = dream.enabled;
    if (typeof dream.autoTrigger === "boolean") config.autoTrigger = dream.autoTrigger;
    if (typeof dream.minHoursSinceDream === "number") config.minHoursSinceDream = dream.minHoursSinceDream;
    if (typeof dream.minSessionsSinceDream === "number") config.minSessionsSinceDream = dream.minSessionsSinceDream;
    if (dream.maxSessionsPerRun === null || typeof dream.maxSessionsPerRun === "number") config.maxSessionsPerRun = dream.maxSessionsPerRun;
    if (typeof dream.minerModel === "string" && dream.minerModel) config.minerModel = dream.minerModel;
    if (typeof dream.refinerModel === "string" && dream.refinerModel) config.refinerModel = dream.refinerModel;
    if (typeof dream.advisorModel === "string" && dream.advisorModel) config.advisorModel = dream.advisorModel;
    if (typeof dream.journalDir === "string" && dream.journalDir) config.journalDir = dream.journalDir;
    if (typeof dream.sessionsDir === "string" && dream.sessionsDir) config.sessionsDir = dream.sessionsDir;
    if (typeof dream.skillsDir === "string" && dream.skillsDir) config.skillsDir = dream.skillsDir;
  } catch {
    // File doesn't exist or parse error — skip
  }
}
