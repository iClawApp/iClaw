import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';

import { db } from '../../src/db/database';
import { enableGate, disableGate, TUNNEL_ID_HEADER, TUNNELED_HEADER, TUNNELED_VALUE } from '../../src/services/remoteAccessAuth';
import { remoteAccessDevices } from '../../src/services/remoteAccessDevices';
import { remoteAccessState } from '../../src/services/remoteAccessState';
import {
  remoteAccessDeviceChallengeHandler,
  remoteAccessDeviceVerifyHandler,
} from '../../src/services/remoteAccessDeviceAuth';
import { verifyDeviceChallengeSignature } from '../../src/services/remoteAccessDeviceCrypto';

const TUNNEL = 't-testdevice01';
const PASS = 'amber-apple-arrow-aspen-123';

function saveTunnel(): void {
  const now = Date.now();
  remoteAccessState.save({
    id: TUNNEL,
    label: 'Test',
    passphrase: PASS,
    accessToken: randomBytes(32).toString('base64url'),
    durationMs: 30 * 60_000,
    startedAt: now,
    expiresAt: now + 30 * 60_000,
    createdAt: now,
  });
}

function makeKeyMaterial(): { publicKeySpki: string; signChallenge: (challengeB64: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return {
    publicKeySpki,
    signChallenge(challengeB64: string) {
      const challenge = Buffer.from(challengeB64, 'base64url');
      return sign(null, challenge, privateKey).toString('base64url');
    },
  };
}

type MockRes = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): void;
  redirect(code: number, url: string): void;
  setHeader(name: string, value: string): void;
};

function mockRes(): MockRes {
  const state = { statusCode: 200, headers: {} as Record<string, string | string[]>, body: undefined as unknown };
  const res: MockRes = {
    get statusCode() {
      return state.statusCode;
    },
    get headers() {
      return state.headers;
    },
    get body() {
      return state.body;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return;
    },
    redirect(code: number, url: string) {
      state.statusCode = code;
      state.headers.Location = url;
      return;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
  };
  return res;
}

function tunneledReq(body: Record<string, unknown>) {
  return {
    method: 'POST',
    path: '/__ra/device/challenge',
    ip: '127.0.0.1',
    headers: {
      [TUNNELED_HEADER]: TUNNELED_VALUE,
      [TUNNEL_ID_HEADER]: TUNNEL,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body,
  } as Parameters<typeof remoteAccessDeviceChallengeHandler>[0];
}

describe('remoteAccessDeviceAuth', () => {
  beforeEach(() => {
    db.exec('DELETE FROM remote_access_devices');
    remoteAccessState.delete(TUNNEL);
    disableGate(TUNNEL);
    saveTunnel();
    enableGate(TUNNEL, PASS);
  });

  it('registers device via store and issues challenge', () => {
    const { publicKeySpki } = makeKeyMaterial();
    const device = remoteAccessDevices.register({
      tunnelId: TUNNEL,
      publicKey: publicKeySpki,
      name: 'Phone',
      userAgent: 'TestAgent/1.0',
    });
    expect(device.id).toMatch(/^d-/);

    const res = mockRes();
    remoteAccessDeviceChallengeHandler(
      tunneledReq({ deviceId: device.id }),
      res as never,
      () => undefined,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { challengeId: string; challenge: string };
    expect(body.challengeId).toBeTruthy();
    expect(body.challenge).toBeTruthy();
  });

  it('accepts valid signature and updates last_seen_at', () => {
    const keys = makeKeyMaterial();
    const device = remoteAccessDevices.register({
      tunnelId: TUNNEL,
      publicKey: keys.publicKeySpki,
      userAgent: 'UA',
    });
    const seenBefore = device.lastSeenAt;

    const chRes = mockRes();
    remoteAccessDeviceChallengeHandler(
      tunneledReq({ deviceId: device.id }),
      chRes as never,
      () => undefined,
    );
    const ch = chRes.body as { challengeId: string; challenge: string };
    const signature = keys.signChallenge(ch.challenge);
    expect(verifyDeviceChallengeSignature(keys.publicKeySpki, ch.challenge, signature)).toBe(true);

    const vRes = mockRes();
    const vReq = tunneledReq({
      deviceId: device.id,
      challengeId: ch.challengeId,
      signature,
      next: '/',
    });
    vReq.path = '/__ra/device/verify';
    remoteAccessDeviceVerifyHandler(vReq, vRes as never, () => undefined);

    expect(vRes.statusCode).toBe(200);
    expect((vRes.body as { ok: boolean }).ok).toBe(true);
    expect(String(vRes.headers['Set-Cookie'] ?? '')).toContain('iclaw_ra=');

    const updated = remoteAccessDevices.get(TUNNEL, device.id)!;
    expect(updated.lastSeenAt).toBeGreaterThanOrEqual(seenBefore);
  });

  it('rejects invalid signature', () => {
    const keys = makeKeyMaterial();
    const device = remoteAccessDevices.register({
      tunnelId: TUNNEL,
      publicKey: keys.publicKeySpki,
    });

    const chRes = mockRes();
    remoteAccessDeviceChallengeHandler(
      tunneledReq({ deviceId: device.id }),
      chRes as never,
      () => undefined,
    );
    const ch = chRes.body as { challengeId: string; challenge: string };

    const vRes = mockRes();
    const vReq = tunneledReq({
      deviceId: device.id,
      challengeId: ch.challengeId,
      signature: randomBytes(64).toString('base64url'),
      next: '/',
    });
    vReq.path = '/__ra/device/verify';
    remoteAccessDeviceVerifyHandler(vReq, vRes as never, () => undefined);

    expect(vRes.statusCode).toBe(403);
  });

  it('rejects revoked device at challenge', () => {
    const keys = makeKeyMaterial();
    const device = remoteAccessDevices.register({
      tunnelId: TUNNEL,
      publicKey: keys.publicKeySpki,
    });
    remoteAccessDevices.revoke(TUNNEL, device.id);

    const res = mockRes();
    remoteAccessDeviceChallengeHandler(
      tunneledReq({ deviceId: device.id }),
      res as never,
      () => undefined,
    );
    expect(res.statusCode).toBe(403);
  });
});
