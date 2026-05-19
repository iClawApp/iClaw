/**
 * Helpers for tests that want to reset the per-worker DB between cases.
 *
 * DB itself is set up by `test/helpers/setup.ts` (a vitest setup file that
 * pins `DB_PATH` before any `src/db/database.ts` import).
 */

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { db } from '../../src/db/database';

function assertTestDbPath(): void {
  const resolved = resolve(process.cwd(), process.env.DB_PATH ?? './data/iclaw.db');
  const isVitestDb = /iclaw\.test\.db$/i.test(resolved);
  const inTmp = resolved.startsWith(tmpdir()) && resolved.includes('iclaw-test');
  if (!isVitestDb && !inTmp) {
    throw new Error(
      `refusing to wipe database at ${resolved} — use "npm test" (isolated tmp DB), not data/iclaw.db`,
    );
  }
}

/** Wipe all tables — quick reset between tests inside one file. */
export function resetTestDb(): void {
  assertTestDbPath();
  // Order matters because of FKs / cascade.
  db.exec(`
    DELETE FROM project_fact_suggestions;
    DELETE FROM project_facts;
    DELETE FROM project_secrets;
    DELETE FROM scheduled_messages;
    DELETE FROM messages;
    DELETE FROM chats;
    DELETE FROM projects;
    DELETE FROM sqlite_sequence;
  `);
}

export { db };
