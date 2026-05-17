/**
 * Helpers for tests that want to reset the per-worker DB between cases.
 *
 * DB itself is set up by `test/helpers/setup.ts` (a vitest setup file that
 * pins `DB_PATH` before any `src/db/database.ts` import).
 */

import { db } from '../../src/db/database';

/** Wipe all tables — quick reset between tests inside one file. */
export function resetTestDb(): void {
  // Order matters because of FKs / cascade.
  db.exec(`
    DELETE FROM project_fact_suggestions;
    DELETE FROM project_facts;
    DELETE FROM scheduled_messages;
    DELETE FROM messages;
    DELETE FROM chats;
    DELETE FROM projects;
    DELETE FROM sqlite_sequence;
  `);
}

export { db };
