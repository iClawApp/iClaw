import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';

import { db } from '../../src/db/database';
import { remoteAccessDevices } from '../../src/services/remoteAccessDevices';
import { remoteAccessState } from '../../src/services/remoteAccessState';

const TUNNEL = 't-devstore01';

function seedTunnel(): void {
  const now = Date.now();
  remoteAccessState.save({
    id: TUNNEL,
    label: null,
    passphrase: 'test',
    accessToken: 'a'.repeat(43),
    durationMs: 60_000,
    startedAt: now,
    expiresAt: now + 60_000,
    createdAt: now,
  });
}

describe('remoteAccessDevices', () => {
  beforeEach(() => {
    db.exec('DELETE FROM remote_access_devices');
    remoteAccessState.delete(TUNNEL);
    seedTunnel();
  });

  it('registers and revokes a device', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const d = remoteAccessDevices.register({
      tunnelId: TUNNEL,
      publicKey: spki,
      name: 'Laptop',
      userAgent: 'Mozilla/5.0',
    });
    expect(remoteAccessDevices.listByTunnel(TUNNEL)).toHaveLength(1);
    expect(remoteAccessDevices.revoke(TUNNEL, d.id)).toBe(true);
    expect(remoteAccessDevices.getActive(TUNNEL, d.id)).toBeNull();
    expect(remoteAccessDevices.get(TUNNEL, d.id)?.revokedAt).not.toBeNull();
  });

  it('touchLastSeen updates timestamp', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const d = remoteAccessDevices.register({ tunnelId: TUNNEL, publicKey: spki });
    const t0 = d.lastSeenAt;
    remoteAccessDevices.touchLastSeen(TUNNEL, d.id, t0 + 5000);
    expect(remoteAccessDevices.get(TUNNEL, d.id)?.lastSeenAt).toBe(t0 + 5000);
  });

  it('deleteAllForTunnel removes rows', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    remoteAccessDevices.register({ tunnelId: TUNNEL, publicKey: spki });
    remoteAccessDevices.deleteAllForTunnel(TUNNEL);
    expect(remoteAccessDevices.listByTunnel(TUNNEL)).toHaveLength(0);
  });
});
