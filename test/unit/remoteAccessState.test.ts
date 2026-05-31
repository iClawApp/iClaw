import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { db } from '../../src/db/database';
import {
  ensureAccessToken,
  generateTunnelId,
  remoteAccessState,
  type PersistedTunnel,
} from '../../src/services/remoteAccessState';

function baseTunnel(overrides: Partial<PersistedTunnel> = {}): PersistedTunnel {
  const now = Date.now();
  return {
    id: generateTunnelId(),
    label: null,
    passphrase: 'test-pass',
    accessToken: randomBytes(32).toString('base64url'),
    durationMs: 30 * 60_000,
    startedAt: now,
    expiresAt: now + 30 * 60_000,
    createdAt: now,
    ...overrides,
  };
}

describe('remoteAccessState', () => {
  it('persists and loads access_token', () => {
    const t = baseTunnel();
    remoteAccessState.save(t);
    const loaded = remoteAccessState.get(t.id);
    expect(loaded?.accessToken).toBe(t.accessToken);
    remoteAccessState.delete(t.id);
  });

  it('ensureAccessToken backfills empty access_token and saves', () => {
    const t = baseTunnel({ accessToken: '' });
    remoteAccessState.save(t);
    const loaded = remoteAccessState.get(t.id)!;
    const fixed = ensureAccessToken(loaded);
    expect(fixed.accessToken.length).toBeGreaterThanOrEqual(43);
    expect(remoteAccessState.get(t.id)?.accessToken).toBe(fixed.accessToken);
    remoteAccessState.delete(t.id);
  });

  it('list() backfills legacy rows without access_token column value', () => {
    const id = generateTunnelId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO remote_access_tunnels
         (id, label, passphrase, access_token, duration_ms, started_at, expires_at, created_at)
       VALUES (?, NULL, 'p', NULL, ?, ?, ?, ?)`,
    ).run(id, 30 * 60_000, now, now + 30 * 60_000, now);

    const listed = remoteAccessState.list().find((x) => x.id === id);
    expect(listed?.accessToken.length).toBeGreaterThanOrEqual(43);

    remoteAccessState.delete(id);
  });
});
