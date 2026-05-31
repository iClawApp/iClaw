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
import { generateAccessToken } from './remoteAccessToken';

export interface PersistedTunnel {
  id: string;
  label: string | null;
  passphrase: string;
  /** Plaintext relay access token — local DB only; relay stores hash only. */
  accessToken: string;
  /**
   * Tunnel ownership secret — local DB only; relay stores SHA-256 only.
   * Proves to the relay that this iClaw owns the tunnelId, blocking subdomain
   * hijack via reconnect-restore by a stranger who learns the tunnelId.
   */
  ownerSecret: string;
  durationMs: number;
  startedAt: number;
  expiresAt: number;
  createdAt: number;
}

interface Row {
  id: string;
  label: string | null;
  passphrase: string;
  access_token: string | null;
  owner_secret: string | null;
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
    (id, label, passphrase, access_token, owner_secret, duration_ms, started_at, expires_at, created_at)
  VALUES
    (@id, @label, @passphrase, @access_token, @owner_secret, @duration_ms, @started_at, @expires_at, @created_at)
`);
const UPDATE_STMT = db.prepare(`
  UPDATE remote_access_tunnels
     SET label = @label,
         passphrase = @passphrase,
         access_token = @access_token,
         owner_secret = @owner_secret,
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
    accessToken: row.access_token ?? '',
    ownerSecret: row.owner_secret ?? '',
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Backfill access_token for tunnels created before the relay gate. */
export function ensureAccessToken(p: PersistedTunnel): PersistedTunnel {
  if (p.accessToken) return p;
  const updated = { ...p, accessToken: generateAccessToken() };
  remoteAccessState.save(updated);
  return updated;
}

/** Backfill owner_secret for tunnels created before ownership proofs existed. */
export function ensureOwnerSecret(p: PersistedTunnel): PersistedTunnel {
  if (p.ownerSecret) return p;
  const updated = { ...p, ownerSecret: generateOwnerSecret() };
  remoteAccessState.save(updated);
  return updated;
}

export function generateTunnelId(): string {
  // 16 bytes (128-bit) of entropy. The old 5-byte (40-bit) id was guessable
  // enough that, combined with an unauthenticated relay restore, a stranger
  // could target a specific tunnel; ownership proofs are the real defence, but
  // a wide id removes the targeting primitive entirely.
  return `t-${randomBytes(16).toString('hex')}`;
}

/** 256-bit tunnel ownership secret (base64url). Relay stores SHA-256 only. */
export function generateOwnerSecret(): string {
  return randomBytes(32).toString('base64url');
}

export const remoteAccessState = {
  list(): PersistedTunnel[] {
    return LIST_STMT.all().map(rowToTunnel).map(ensureAccessToken);
  },

  get(id: string): PersistedTunnel | null {
    const row = GET_STMT.get(id);
    return row ? ensureAccessToken(rowToTunnel(row)) : null;
  },

  save(t: PersistedTunnel): void {
    const existing = GET_STMT.get(t.id);
    const params = {
      id: t.id,
      label: t.label,
      passphrase: t.passphrase,
      access_token: t.accessToken,
      owner_secret: t.ownerSecret,
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
