import * as opaque from '@serenity-kit/opaque';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { remoteAccess } from '../../src/services/remoteAccess';
import { remoteAccessState } from '../../src/services/remoteAccessState';
import { hashAccessToken, verifyAccessToken } from '../../src/services/remoteAccessToken';

describe('remoteAccess.regenerateAccessToken', () => {
  const tunnelId = 't-regen-test';

  afterEach(() => {
    vi.unstubAllEnvs();
    remoteAccess.deleteTunnel(tunnelId);
  });

  it('mints new access token and invalidates old token', async () => {
    vi.stubEnv('ICLAW_RELAY_URL', 'ws://127.0.0.1:9');
    vi.stubEnv('OPAQUE_SERVER_SETUP', opaque.server.createSetup());
    remoteAccess.configure({
      relayUrl: 'ws://127.0.0.1:9',
      localHost: '127.0.0.1',
      localPort: 3000,
    });

    const created = await remoteAccess.createTunnel(30 * 60_000, 'regen-test');
    const oldToken = remoteAccessState.get(created.id)!.accessToken;
    const oldHash = hashAccessToken(oldToken);

    const updated = remoteAccess.regenerateAccessToken(created.id);
    expect(updated).toBeTruthy();
    const newToken = remoteAccessState.get(created.id)!.accessToken;
    expect(newToken).not.toBe(oldToken);
    expect(verifyAccessToken(oldToken, hashAccessToken(newToken))).toBe(false);
    expect(verifyAccessToken(newToken, hashAccessToken(newToken))).toBe(true);
  });
});
