import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL DEFAULT 'New chat',
  agent               TEXT NOT NULL,
  openclaw_session_id TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  title_manual        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  finish_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
`;

function dropObsoleteTables(db: Database.Database): void {
  // Earlier MVP had projects/tasks/notes. We're now flat: chats only.
  db.exec('DROP TABLE IF EXISTS notes');
  db.exec('DROP TABLE IF EXISTS tasks');
  db.exec('DROP TABLE IF EXISTS projects');
}

const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? './data/iclaw.db');
mkdirSync(dirname(dbPath), { recursive: true });

// Backwards-compatible migration: if a legacy ./data/iclaude.db (and its WAL
// sidecars) exists from before the iClaude → iClaw rename, move it in place.
// Only triggers when DB_PATH wasn't overridden and the new file doesn't exist.
if (!process.env.DB_PATH) {
  const legacy = resolve(process.cwd(), './data/iclaude.db');
  if (existsSync(legacy) && !existsSync(dbPath)) {
    renameSync(legacy, dbPath);
    for (const ext of ['-shm', '-wal']) {
      if (existsSync(legacy + ext)) renameSync(legacy + ext, dbPath + ext);
    }
  }
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
dropObsoleteTables(db);
db.exec(SCHEMA);

function migrateChatsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'title_manual')) {
    database.exec(
      'ALTER TABLE chats ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0',
    );
  }
}

migrateChatsSchema(db);
