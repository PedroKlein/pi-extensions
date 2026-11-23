import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface DbPathResolverOptions {
  agentDir: string;
  cwd: string;
  isProjectTrusted: boolean;
  configDirName: string;
  /** Injectable for tests; never opens the default database. */
  homeDir?: string;
}

/** Report only known error types, never raw parser/SQLite messages or config values. */
export function errorType(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && [
      "ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", "EIO", "ENOSPC",
      "EROFS", "EMFILE", "ENFILE", "ENAMETOOLONG", "ERR_SQLITE_ERROR",
    ].includes(code)) return code;
  }
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof TypeError) return "TypeError";
  return "Error";
}

export class DbPathError extends Error {
  constructor(path: string, type: string) {
    super(`${path}: ${type}`);
    this.name = "DbPathError";
  }
}

function normalizeAgentDir(path: string, home: string): string {
  return resolve(path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

/** ENOENT is absence only if no existing path component is a dangling symlink. */
function isMissingPath(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorType(error) !== "ENOENT") throw new DbPathError(path, errorType(error));
    const parent = dirname(path);
    if (parent === path) throw new DbPathError(path, "ENOENT");
    isMissingPath(parent);
    return true;
  }
  if (stat.isSymbolicLink()) {
    // lstat does not follow the final link; realpath must succeed for it to be valid.
    try {
      realpathSync(path);
    } catch (error) {
      throw new DbPathError(path, errorType(error));
    }
  }
  return false;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errorType(error) === "ENOENT") {
      if (isMissingPath(path)) return resolve(path);
      // Another starter may have created the directory between realpath and lstat.
      // Resolve once more (also following aliases); all errors still fail closed.
      try {
        return realpathSync(path);
      } catch (retryError) {
        throw new DbPathError(path, errorType(retryError));
      }
    }
    throw new DbPathError(path, errorType(error));
  }
}

export type StorageMode = "legacy-global" | "agent-local" | "project-local";

export interface ResolvedStorage {
  agentDir: string;
  dbPath: string;
  mode: StorageMode;
}

/** Trusted project override, then the current agent's default; never fall back on errors. */
export function resolveStorage(options: DbPathResolverOptions): ResolvedStorage {
  const { agentDir, cwd, isProjectTrusted, configDirName, homeDir = homedir() } = options;
  const normalized = normalizeAgentDir(agentDir, homeDir);
  if (isProjectTrusted) {
    const projectPath = readProjectLocalPath(cwd, configDirName);
    if (projectPath !== undefined) {
      return { agentDir: normalized, dbPath: projectPath, mode: "project-local" };
    }
  }

  const standard = resolve(homeDir, ".pi", "agent");
  return canonicalPath(normalized) === canonicalPath(standard)
    ? { agentDir: normalized, dbPath: resolve(homeDir, ".pi", "memory", "memory.db"), mode: "legacy-global" }
    : { agentDir: normalized, dbPath: join(normalized, "memory", "memory.db"), mode: "agent-local" };
}

/** Compatibility wrapper; resolution (including project settings) happens only once. */
export function resolveDbPath(options: DbPathResolverOptions): string {
  return resolveStorage(options).dbPath;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProjectLocalPath(cwd: string, configDirName: string): string | undefined {
  const settingsPath = resolve(cwd, configDirName, "settings.json");
  let content: string;
  try {
    content = readFileSync(settingsPath, "utf-8");
  } catch (error) {
    if (errorType(error) === "ENOENT" && isMissingPath(settingsPath)) return undefined;
    throw new DbPathError(settingsPath, errorType(error));
  }

  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    throw new DbPathError(settingsPath, "SyntaxError");
  }
  if (!isObject(settings)) throw new DbPathError(settingsPath, "TypeError (settings)");
  if (!("pi-memory" in settings)) return undefined;
  const section = settings["pi-memory"];
  if (!isObject(section)) throw new DbPathError(settingsPath, "TypeError (pi-memory)");
  if (!("localPath" in section)) return undefined;
  const localPath = section.localPath;
  if (typeof localPath !== "string" || !localPath.trim() || localPath.includes("\0")) {
    throw new DbPathError(settingsPath, "TypeError (pi-memory.localPath)");
  }
  // Preserve directory semantics: relative to cwd, not the settings file or agentDir.
  return join(resolve(cwd, localPath), "memory.db");
}
