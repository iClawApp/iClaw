import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL DEFAULT 'New chat',
  agent               TEXT NOT NULL,
  openclaw_session_id TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
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

const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? './data/iclaude.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
dropObsoleteTables(db);
db.exec(SCHEMA);
