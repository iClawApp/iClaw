import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDbPath } from '../paths';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  logo_emoji  INTEGER NOT NULL DEFAULT 0,
  logo_color  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL DEFAULT 'New chat',
  agent               TEXT NOT NULL,
  openclaw_session_id TEXT NOT NULL,
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  shares_to_project   INTEGER NOT NULL DEFAULT 1,
  -- Optional per-session model override applied via sessions.patch.
  model_override      TEXT,
  -- Reasoning visibility mirror; actual state lives on the gateway.
  reasoning_mode      TEXT NOT NULL DEFAULT 'off',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  title_manual        INTEGER NOT NULL DEFAULT 0,
  unread              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id              INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL,
  content              TEXT NOT NULL,
  finish_reason        TEXT,
  reply_to_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  reply_quote          TEXT,
  reply_to_role        TEXT,
  /** JSON array of {url, mimeType, fileName, sizeBytes} for user-attached files. NULL when no attachments. */
  attachments          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  source_chat_id    INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts(project_id, id);
CREATE INDEX IF NOT EXISTS idx_facts_project_created ON project_facts(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_fact_suggestions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id              INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content              TEXT NOT NULL,
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fact_suggestions_chat ON project_fact_suggestions(chat_id, id);

CREATE TABLE IF NOT EXISTS project_secrets (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  label                TEXT NOT NULL,
  value                TEXT NOT NULL,
  source_chat_id       INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  source_message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id, id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_orphan_chat ON project_secrets(source_chat_id, id);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  /** Stored as 'YYYY-MM-DD HH:MM:SS' UTC — comparable with datetime('now'). */
  scheduled_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_chat ON scheduled_messages(chat_id, scheduled_at);

-- Robustness: any new message bumps the parent chat's updated_at so sidebar
-- sorting is always correct even if a caller forgets the manual chats.touch().
CREATE TRIGGER IF NOT EXISTS trg_chats_touch_on_message
AFTER INSERT ON messages
BEGIN
  UPDATE chats SET updated_at = datetime('now') WHERE id = NEW.chat_id;
END;
`;

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

/** Idempotent ALTER TABLE for older DBs created before the column existed. */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('messages', 'attachments', 'TEXT');

/** Older DBs created project_secrets.project_id as NOT NULL; orphan chat secrets need NULL. */
function migrateProjectSecretsNullableProjectId(): void {
  const cols = db.prepare('PRAGMA table_info(project_secrets)').all() as {
    name: string;
    notnull: number;
  }[];
  const projectIdCol = cols.find((c) => c.name === 'project_id');
  if (!projectIdCol || projectIdCol.notnull === 0) return;

  const fkOn = db.pragma('foreign_keys', { simple: true }) as number;
  if (fkOn) db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE project_secrets__migrate (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id           INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        label                TEXT NOT NULL,
        value                TEXT NOT NULL,
        source_chat_id       INTEGER REFERENCES chats(id) ON DELETE SET NULL,
        source_message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO project_secrets__migrate (
        id, project_id, label, value, source_chat_id, source_message_id, created_at
      )
      SELECT id, project_id, label, value, source_chat_id, source_message_id, created_at
      FROM project_secrets;
      DROP TABLE project_secrets;
      ALTER TABLE project_secrets__migrate RENAME TO project_secrets;
      CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_project_secrets_orphan_chat ON project_secrets(source_chat_id, id);
    `);
  } finally {
    if (fkOn) db.pragma('foreign_keys = ON');
  }
}
migrateProjectSecretsNullableProjectId();

/** SQLite's lower() is ASCII-only; JS toLowerCase() folds Cyrillic and other scripts for search. */
db.function(
  'unicode_lower',
  { deterministic: true },
  (text: unknown): string | null => {
    if (text == null) return null;
    if (typeof text === 'string') return text.toLowerCase();
    return null;
  },
);
