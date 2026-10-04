import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SemanticEntry {
  key: string;
  value: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  pinned?: number;
}

export interface MemoryEvent {
  id: number;
  event_type: string;
  memory_type: string;
  memory_key: string;
  details: string;
  created_at: string;
}

export type MemoryScope = "current" | "global" | "all";

export interface SemanticQuery {
  query?: string;
  scope?: MemoryScope;
  project?: string;
  limit?: number;
  offset?: number;
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const directory = dirname(dbPath);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    try {
      this.db.exec("ALTER TABLE semantic ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Existing databases already have this column.
    }
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSemantic(key: string): SemanticEntry | undefined {
    return this.db.prepare("SELECT * FROM semantic WHERE key = ?")
      .get(key.toLowerCase()) as unknown as SemanticEntry | undefined;
  }

  setSemantic(
    key: string,
    value: string,
    confidence = 0.95,
    source = "user",
  ): void {
    assertSemanticKey(key);
    assertSafeMemoryValue(value);
    const normalized = key.toLowerCase();

    this.withTransaction(() => {
      const existing = this.getSemantic(normalized);
      if (existing?.source === "user" && source !== "user" && existing.confidence > confidence) {
        return;
      }

      this.db.prepare(`
        INSERT INTO semantic (key, value, confidence, source, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          confidence = excluded.confidence,
          source = excluded.source,
          updated_at = datetime('now')
      `).run(normalized, value, confidence, source);
      this.logEvent(existing ? "update" : "create", "semantic", normalized);
    });
  }

  deleteSemantic(key: string): boolean {
    const normalized = key.toLowerCase();
    return this.withTransaction(() => {
      const result = this.db.prepare("DELETE FROM semantic WHERE key = ?").run(normalized);
      if (result.changes > 0) this.logEvent("delete", "semantic", normalized);
      return result.changes > 0;
    });
  }

  querySemantic(options: SemanticQuery = {}): { entries: SemanticEntry[]; total: number } {
    const query = options.query?.trim().toLowerCase() ?? "";
    const scope = options.scope ?? "current";
    const project = options.project?.toLowerCase();
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const { clause, params } = semanticScope(scope, project);
    const all = this.db.prepare(`SELECT * FROM semantic WHERE ${clause}`)
      .all(...params) as unknown as SemanticEntry[];

    const ranked = query
      ? all
          .map((entry) => {
            const text = `${entry.key} ${entry.value}`.toLowerCase();
            const terms = query.split(/\s+/).filter(Boolean);
            const matches = terms.filter((term) => text.includes(term)).length;
            return { entry, score: terms.length === 0 ? 0 : matches / terms.length };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
          .map(({ entry }) => entry)
      : all.sort((a, b) => a.key.localeCompare(b.key));

    return {
      entries: ranked.slice(offset, offset + limit),
      total: ranked.length,
    };
  }

  listPinned(): SemanticEntry[] {
    return this.db.prepare("SELECT * FROM semantic WHERE pinned = 1 ORDER BY key")
      .all() as unknown as SemanticEntry[];
  }

  pin(key: string): boolean {
    return this.db.prepare("UPDATE semantic SET pinned = 1 WHERE key = ?")
      .run(key.toLowerCase()).changes > 0;
  }

  unpin(key: string): boolean {
    return this.db.prepare("UPDATE semantic SET pinned = 0 WHERE key = ?")
      .run(key.toLowerCase()).changes > 0;
  }

  listEvents(limit = 50): MemoryEvent[] {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as MemoryEvent[];
  }

  stats(): { semantic: number; events: number } {
    const semantic = (this.db.prepare("SELECT COUNT(*) AS count FROM semantic").get() as { count: number }).count;
    const events = (this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
    return { semantic, events };
  }

  close(): void {
    this.db.close();
  }

  private logEvent(eventType: string, memoryType: string, key: string, details = ""): void {
    this.db.prepare(
      "INSERT INTO events (event_type, memory_type, memory_key, details) VALUES (?, ?, ?, ?)",
    ).run(eventType, memoryType, key, details);
  }
}

function semanticScope(scope: MemoryScope, project?: string): { clause: string; params: string[] } {
  if (scope === "all") return { clause: "1 = 1", params: [] };
  if (scope === "global" || !project) return { clause: "key NOT LIKE 'project.%'", params: [] };
  return {
    clause: "(key NOT LIKE 'project.%' OR key LIKE ?)",
    params: [`project.${project}.%`],
  };
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\btvly-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
];

function assertSemanticKey(key: string): void {
  if (!/^[a-z][a-z0-9._-]{1,99}$/i.test(key)) {
    throw new Error("Memory key must be 2-100 characters using letters, numbers, dots, underscores, or hyphens");
  }
}

function assertSafeMemoryValue(value: string): void {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Memory value appears to contain a credential and was not stored");
  }
}
