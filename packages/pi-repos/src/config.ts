/**
 * pi-repos — Configuration loading and path helpers.
 *
 * Reads from ~/.pi/agent/settings.json under the "pi-repos" key.
 * Missing or invalid → silent fallback to defaults.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type ReposConfig, type HooksConfig, DEFAULT_CONFIG } from "./types.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Expand leading ~ to the home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Load config from settings.json["pi-repos"], merging onto defaults.
 * Never throws.
 */
export function loadConfig(): ReposConfig {
  let user: Partial<ReposConfig> = {};
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    const piRepos = settings?.["pi-repos"];
    if (piRepos && typeof piRepos === "object") user = piRepos;
  } catch {
    // missing or unparseable — use defaults
  }

  return {
    storageDir: expandTilde(
      typeof user.storageDir === "string" ? user.storageDir : DEFAULT_CONFIG.storageDir
    ),
    summaryModel:
      typeof user.summaryModel === "string" ? user.summaryModel : undefined,
    hooks: parseHooks(user.hooks),
  };
}

/** Parse and validate hooks config. Returns undefined if invalid/missing. */
function parseHooks(raw: unknown): HooksConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const hooks: HooksConfig = {};
  const validEvents = ["post-add", "post-sync", "pre-remove"] as const;
  for (const event of validEvents) {
    const entries = (raw as any)[event];
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries
      .filter((e: any) => typeof e?.command === "string" && Array.isArray(e?.args))
      .map((e: any) => ({
        command: e.command,
        args: e.args.map(String),
        timeout: typeof e.timeout === "number" ? e.timeout : undefined,
      }));
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/** All storage sub-paths derived from config. */
export function getPaths(config: ReposConfig) {
  const base = expandTilde(config.storageDir);
  return {
    base,
    repos:  join(base, "repos"),
    groups: join(base, "groups"),
    index:  join(base, "index.json"),
  };
}
