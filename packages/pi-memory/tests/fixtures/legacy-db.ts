import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const legacyFact = {
  key: "pref.legacy",
  value: "original editor",
  confidence: 0.87,
  source: "user",
  created_at: "2020-01-02 03:04:05",
  updated_at: "2021-06-07 08:09:10",
};
export const legacyEvent = {
  id: 7,
  event_type: "create",
  memory_type: "semantic",
  memory_key: legacyFact.key,
  details: "original event",
  created_at: legacyFact.created_at,
};

/** Real upstream-shaped database in a caller-owned temporary directory only. */
export function createLegacyDb(path: string, pinned: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE semantic (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))${pinned ? ", pinned INTEGER NOT NULL DEFAULT 0" : ""}
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE lessons (id TEXT PRIMARY KEY, rule TEXT, created_at TEXT);
      INSERT INTO lessons VALUES ('lesson-1', 'untouched lesson', '2019-02-03 04:05:06');
      CREATE TABLE dream_runs (id INTEGER PRIMARY KEY, summary TEXT, created_at TEXT);
      INSERT INTO dream_runs VALUES (42, 'untouched dream', '2018-01-02 03:04:05');
    `);
    db.prepare(`INSERT INTO semantic VALUES (?, ?, ?, ?, ?, ?${pinned ? ", 1" : ""})`)
      .run(...Object.values(legacyFact));
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(...Object.values(legacyEvent));
  } finally {
    db.close();
  }
}

export function legacyTables(db: DatabaseSync) {
  return ["lessons", "dream_runs"].map((name) => ({
    schema: db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name),
    rows: db.prepare(`SELECT * FROM ${name}`).all(),
  }));
}
