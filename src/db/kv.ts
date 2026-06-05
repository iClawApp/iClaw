/**
 * Tiny typed accessor over the `iclaw_kv` table — a plain string key/value
 * store for app-level settings that don't deserve their own table (e.g. the
 * OpenRouter API key entered in Settings).
 *
 * Deliberately low-level: imports ONLY `db`, so modules like `config.ts` can
 * read settings without pulling in the higher-level `store.ts` (which would
 * create an import cycle: config → store → chatModes → openRouter → config).
 */

import { db } from './database';

const getStmt = db.prepare('SELECT value FROM iclaw_kv WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO iclaw_kv (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);
const delStmt = db.prepare('DELETE FROM iclaw_kv WHERE key = ?');

export function kvGet(key: string): string | null {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  setStmt.run(key, value);
}

export function kvDelete(key: string): void {
  delStmt.run(key);
}
