import { createHash } from "node:crypto";

/**
 * Session-scoped cache for compiled BAML runtimes.
 *
 * Keyed by content hash of file contents.
 * Hash is stable regardless of file key ordering.
 */
export class RuntimeCache<T> {
  private readonly cache = new Map<string, T>();

  /**
   * Get a cached runtime or create one via factory.
   *
   * If a runtime with the same content hash already exists,
   * returns the cached instance. Otherwise calls factory and caches the result.
   */
  getOrCreate(
    files: Record<string, string>,
    factory: (files: Record<string, string>) => T,
  ): T {
    const key = hashFiles(files);
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const runtime = factory(files);
    this.cache.set(key, runtime);
    return runtime;
  }

  /** Remove all cached entries. */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Produce a stable hash of file contents.
 *
 * Sorts keys alphabetically so ordering doesn't affect the hash.
 */
function hashFiles(files: Record<string, string>): string {
  const hasher = createHash("sha256");
  const sortedKeys = Object.keys(files).sort();

  for (const key of sortedKeys) {
    hasher.update(key);
    hasher.update("\0");
    hasher.update(files[key] ?? "");
    hasher.update("\0");
  }

  return hasher.digest("hex");
}
