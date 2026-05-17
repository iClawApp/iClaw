/**
 * Global test setup — runs once per Vitest worker (per file with `pool: forks`).
 *
 * Pins `DB_PATH` to a unique tmp file BEFORE `src/db/database.ts` is imported,
 * so every test file gets its own isolated SQLite instance with the
 * production schema + migrations applied.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'iclaw-test-'));
process.env.DB_PATH = join(dir, 'iclaw.test.db');
// Keep production behaviour disabled — we don't want gateway events firing.
process.env.NODE_ENV = 'test';

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
