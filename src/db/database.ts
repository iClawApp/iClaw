import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  title_manual        INTEGER NOT NULL DEFAULT 0,
  unread              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  finish_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
`;

function dropObsoleteTables(db: Database.Database): void {
  // Old MVP tables that have no place in the current schema.
  db.exec('DROP TABLE IF EXISTS notes');
  db.exec('DROP TABLE IF EXISTS tasks');
  // NOTE: do NOT drop `projects` here anymore — it's back in active use
  // as part of the project-context layer.
}

const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? './data/iclaw.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
dropObsoleteTables(db);
db.exec(SCHEMA);

function migrateSchema(database: Database.Database): void {
  // chats — additive column migrations (each guarded so it only runs once)
  const chatCols = database.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
  const chatColNames = new Set(chatCols.map((c) => c.name));

  if (!chatColNames.has('title_manual')) {
    database.exec('ALTER TABLE chats ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0');
  }
  if (!chatColNames.has('unread')) {
    database.exec('ALTER TABLE chats ADD COLUMN unread INTEGER NOT NULL DEFAULT 0');
  }
  if (!chatColNames.has('project_id')) {
    // SQLite >= 3.35 supports FK clause in ALTER TABLE ADD COLUMN, but only
    // when the column is nullable + has no DEFAULT that violates the FK.
    // We use NULL default which is always safe.
    database.exec(
      'ALTER TABLE chats ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL',
    );
  }
  if (!chatColNames.has('shares_to_project')) {
    database.exec('ALTER TABLE chats ADD COLUMN shares_to_project INTEGER NOT NULL DEFAULT 1');
  }

  // projects — older installs (pre-v0.1) might have a projects table without
  // updated_at. Add it on the fly.
  const projectsExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
    .get();
  if (projectsExists) {
    const projCols = database.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!projCols.some((c) => c.name === 'updated_at')) {
      database.exec(
        "ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
      );
    }
    const hadLogoEmoji = projCols.some((c) => c.name === 'logo_emoji');
    const hadLogoPreset = projCols.some((c) => c.name === 'logo_preset');
    if (!hadLogoEmoji) {
      database.exec('ALTER TABLE projects ADD COLUMN logo_emoji INTEGER NOT NULL DEFAULT 0');
    }
    if (!projCols.some((c) => c.name === 'logo_color')) {
      database.exec('ALTER TABLE projects ADD COLUMN logo_color INTEGER NOT NULL DEFAULT 0');
    }
    if (!hadLogoEmoji && hadLogoPreset) {
      // One-time migration from the old single-int preset to the emoji+color
      // split. After this runs `logo_preset` is dead weight.
      database.exec(`
        UPDATE projects SET
          logo_emoji = ABS(COALESCE(logo_preset, 0)) % 10,
          logo_color = (ABS(COALESCE(logo_preset, 0)) / 10) % 10
        WHERE 1 = 1
      `);
    }
    if (hadLogoPreset) {
      // SQLite 3.35+ supports DROP COLUMN. better-sqlite3 ships a modern
      // SQLite, so this works on every supported install.
      try {
        database.exec('ALTER TABLE projects DROP COLUMN logo_preset');
      } catch {
        /* Older SQLite — leave the dead column alone, it's harmless. */
      }
    }
  }
}

migrateSchema(db);

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

/** Must run after `migrateSchema` — old DBs have `chats` without `project_id` until ALTER. */
function ensureChatsProjectIndex(database: Database.Database): void {
  const chatCols = database.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
  if (!chatCols.some((c) => c.name === 'project_id')) return;
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC)',
  );
}

ensureChatsProjectIndex(db);
