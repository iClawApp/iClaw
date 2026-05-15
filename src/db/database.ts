import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  openclaw_session_id TEXT,                  -- locally-generated session key (x-openclaw-session-key)
  agent               TEXT,                  -- e.g. 'openclaw/default'
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,                -- 'user' | 'assistant' | 'system'
  content      TEXT NOT NULL,
  finish_reason TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id);
`;

function migrate(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('agent')) {
    db.exec('ALTER TABLE tasks ADD COLUMN agent TEXT');
  }
}

const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? './data/iclaude.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);
migrate(db);
