/**
 * Persistent storage for the Remote Access feature.
 *
 * One row per active tunnel. The runtime ({@link ./remoteAccess.ts})
 * keeps an in-memory `Map<tunnelId, RuntimeTunnel>` alongside this, and
 * mirrors changes here so any tunnel enabled with e.g. 30-day duration
 * survives an iClaw restart.
 *
 * Plaintext passphrase storage — the iClaw DB lives on the user's local
 * machine and isn't synced. Encrypted-at-rest is a follow-up if/when we
 * add cloud sync.
 */

import { randomBytes } from 'node:crypto';
import { db } from '../db/database';

export interface PersistedTunnel {
  id: string;
  label: string | null;
  passphrase: string;
  durationMs: number;
  startedAt: number;
  expiresAt: number;
  createdAt: number;
}

interface Row {
  id: string;
  label: string | null;
  passphrase: string;
  duration_ms: number;
  started_at: number;
  expires_at: number;
  created_at: number;
}

const LIST_STMT = db.prepare<[], Row>(
  'SELECT * FROM remote_access_tunnels ORDER BY created_at ASC',
);
const GET_STMT = db.prepare<[string], Row>(
  'SELECT * FROM remote_access_tunnels WHERE id = ?',
);
const INSERT_STMT = db.prepare(`
  INSERT INTO remote_access_tunnels
    (id, label, passphrase, duration_ms, started_at, expires_at, created_at)
  VALUES
    (@id, @label, @passphrase, @duration_ms, @started_at, @expires_at, @created_at)
`);
const UPDATE_STMT = db.prepare(`
  UPDATE remote_access_tunnels
     SET label = @label,
         passphrase = @passphrase,
         duration_ms = @duration_ms,
         started_at = @started_at,
         expires_at = @expires_at
   WHERE id = @id
`);
const DELETE_STMT = db.prepare('DELETE FROM remote_access_tunnels WHERE id = ?');
const DELETE_ALL_STMT = db.prepare('DELETE FROM remote_access_tunnels');

function rowToTunnel(row: Row): PersistedTunnel {
  return {
    id: row.id,
    label: row.label,
    passphrase: row.passphrase,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function generateTunnelId(): string {
  return `t-${randomBytes(5).toString('hex')}`;
}

export const remoteAccessState = {
  list(): PersistedTunnel[] {
    return LIST_STMT.all().map(rowToTunnel);
  },

  get(id: string): PersistedTunnel | null {
    const row = GET_STMT.get(id);
    return row ? rowToTunnel(row) : null;
  },

  save(t: PersistedTunnel): void {
    const existing = GET_STMT.get(t.id);
    const params = {
      id: t.id,
      label: t.label,
      passphrase: t.passphrase,
      duration_ms: t.durationMs,
      started_at: t.startedAt,
      expires_at: t.expiresAt,
      created_at: t.createdAt,
    };
    if (existing) {
      UPDATE_STMT.run(params);
    } else {
      INSERT_STMT.run(params);
    }
  },

  delete(id: string): void {
    DELETE_STMT.run(id);
  },

  clearAll(): void {
    DELETE_ALL_STMT.run();
  },
};
