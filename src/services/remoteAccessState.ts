/**
 * Persistent state for the Remote Access feature.
 *
 * Single-row table (`remote_access_state`, id=1). Mirrors what the user
 * configured on the Settings page so a tunnel enabled with e.g. 7-day
 * duration survives iClaw restarts.
 *
 * Plaintext passphrase storage — the iClaw DB lives on the user's local
 * machine and isn't synced. Encrypted-at-rest is a follow-up if/when we
 * add cloud sync.
 */

import { db } from '../db/database';

export interface RemoteAccessPersistedState {
  enabled: boolean;
  passphrase: string;
  durationMs: number;
  startedAt: number;
  expiresAt: number;
}

interface Row {
  id: number;
  enabled: number;
  passphrase: string | null;
  duration_ms: number | null;
  started_at: number | null;
  expires_at: number | null;
  updated_at: number;
}

const SELECT_STMT = db.prepare<[], Row>('SELECT * FROM remote_access_state WHERE id = 1');

const UPSERT_STMT = db.prepare(`
  INSERT INTO remote_access_state (id, enabled, passphrase, duration_ms, started_at, expires_at, updated_at)
  VALUES (1, @enabled, @passphrase, @duration_ms, @started_at, @expires_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    enabled     = excluded.enabled,
    passphrase  = excluded.passphrase,
    duration_ms = excluded.duration_ms,
    started_at  = excluded.started_at,
    expires_at  = excluded.expires_at,
    updated_at  = excluded.updated_at
`);

const CLEAR_STMT = db.prepare(`
  INSERT INTO remote_access_state (id, enabled, passphrase, duration_ms, started_at, expires_at, updated_at)
  VALUES (1, 0, NULL, NULL, NULL, NULL, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    enabled     = 0,
    passphrase  = NULL,
    duration_ms = NULL,
    started_at  = NULL,
    expires_at  = NULL,
    updated_at  = excluded.updated_at
`);

export const remoteAccessState = {
  /** Returns the persisted state, or null when nothing was ever saved / row was cleared. */
  get(): RemoteAccessPersistedState | null {
    const row = SELECT_STMT.get();
    if (!row || row.enabled !== 1) return null;
    if (
      row.passphrase === null ||
      row.duration_ms === null ||
      row.started_at === null ||
      row.expires_at === null
    ) {
      return null;
    }
    return {
      enabled: true,
      passphrase: row.passphrase,
      durationMs: row.duration_ms,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
    };
  },

  save(state: RemoteAccessPersistedState): void {
    UPSERT_STMT.run({
      enabled: state.enabled ? 1 : 0,
      passphrase: state.passphrase,
      duration_ms: state.durationMs,
      started_at: state.startedAt,
      expires_at: state.expiresAt,
      updated_at: Date.now(),
    });
  },

  clear(): void {
    CLEAR_STMT.run({ updated_at: Date.now() });
  },
};
