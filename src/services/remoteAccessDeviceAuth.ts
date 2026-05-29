/**
 * Challenge-response auth for persisted Remote Access devices.
 */

import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

import { remoteAccessDevices } from './remoteAccessDevices';
import { verifyDeviceChallengeSignature, isValidDevicePublicKey } from './remoteAccessDeviceCrypto';
import {
  attachSessionCookie,
  getTunnelIdFromRequest,
  isGateEnabled,
  isTunneledRequest,
  parseCookieHeader,
  isValidTunnelSessionForTunnel,
} from './remoteAccessAuth';

const CHALLENGE_TTL_MS = 60_000;
const CHALLENGE_PREFIX = '/__ra/device/';

interface PendingChallenge {
  tunnelId: string;
  deviceId: string;
  challengeB64: string;
  expiresAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();

function sweepChallenges(): void {
  const now = Date.now();
  for (const [id, c] of pendingChallenges) {
    if (c.expiresAt <= now) pendingChallenges.delete(id);
  }
}

export function isDeviceAuthPath(path: string): boolean {
  return path.startsWith(CHALLENGE_PREFIX);
}

export function registerTrustedDevice(opts: {
  tunnelId: string;
  publicKey: string;
  name?: string | null;
  userAgent?: string | null;
}): { deviceId: string } | null {
  if (!isValidDevicePublicKey(opts.publicKey)) return null;
  const device = remoteAccessDevices.register({
    tunnelId: opts.tunnelId,
    publicKey: opts.publicKey,
    name: opts.name,
    userAgent: opts.userAgent,
  });
  return { deviceId: device.id };
}

function parseDeviceBody(req: Request): { deviceId?: string; challengeId?: string; signature?: string } {
  const body = req.body as Record<string, unknown> | undefined;
  return {
    deviceId: typeof body?.deviceId === 'string' ? body.deviceId : undefined,
    challengeId: typeof body?.challengeId === 'string' ? body.challengeId : undefined,
    signature: typeof body?.signature === 'string' ? body.signature : undefined,
  };
}

export const remoteAccessDeviceChallengeHandler: RequestHandler = (req, res) => {
  if (!isTunneledRequest(req)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }
  const tunnelId = getTunnelIdFromRequest(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }

  const { deviceId } = parseDeviceBody(req);
  if (!deviceId) {
    res.status(400).json({ error: 'deviceId required' });
    return;
  }

  const device = remoteAccessDevices.getActive(tunnelId, deviceId);
  if (!device) {
    res.status(403).json({ error: 'device not found or revoked' });
    return;
  }

  sweepChallenges();
  const challengeId = randomBytes(16).toString('base64url');
  const challengeB64 = randomBytes(32).toString('base64url');
  pendingChallenges.set(challengeId, {
    tunnelId,
    deviceId,
    challengeB64,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });

  res.json({ challengeId, challenge: challengeB64 });
};

export const remoteAccessDeviceVerifyHandler: RequestHandler = (req, res) => {
  if (!isTunneledRequest(req)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }
  const tunnelId = getTunnelIdFromRequest(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }

  const { deviceId, challengeId, signature } = parseDeviceBody(req);
  if (!deviceId || !challengeId || !signature) {
    res.status(400).json({ error: 'deviceId, challengeId, and signature required' });
    return;
  }

  const pending = pendingChallenges.get(challengeId);
  pendingChallenges.delete(challengeId);
  if (!pending || pending.expiresAt <= Date.now()) {
    res.status(403).json({ error: 'challenge expired' });
    return;
  }
  if (pending.tunnelId !== tunnelId || pending.deviceId !== deviceId) {
    res.status(403).json({ error: 'challenge mismatch' });
    return;
  }

  const device = remoteAccessDevices.getActive(tunnelId, deviceId);
  if (!device) {
    res.status(403).json({ error: 'device not found or revoked' });
    return;
  }

  if (
    !verifyDeviceChallengeSignature(device.publicKey, pending.challengeB64, signature)
  ) {
    res.status(403).json({ error: 'invalid signature' });
    return;
  }

  remoteAccessDevices.touchLastSeen(tunnelId, deviceId);
  finishDeviceLogin(res, tunnelId, req);
};

function finishDeviceLogin(res: Response, tunnelId: string, req: Request): void {
  attachSessionCookie(res, tunnelId, req);
  const nextUrl =
    typeof req.body?.next === 'string' && req.body.next.startsWith('/')
      ? req.body.next
      : '/';
  const accept = (req.headers.accept ?? '').toString();
  if (accept.includes('application/json')) {
    res.json({ ok: true, next: nextUrl });
    return;
  }
  res.redirect(303, nextUrl);
}

/** Optional: register device when caller already has a fresh session cookie. */
export const remoteAccessDeviceRegisterHandler: RequestHandler = (req, res) => {
  if (!isTunneledRequest(req)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }
  const tunnelId = getTunnelIdFromRequest(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  if (!isValidTunnelSessionForTunnel(tunnelId, cookies)) {
    res.status(401).json({ error: 'passphrase session required' });
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
  const name = typeof body?.name === 'string' ? body.name : null;
  const userAgent =
    typeof body?.userAgent === 'string'
      ? body.userAgent
      : (req.headers['user-agent'] ?? '').toString();

  const registered = registerTrustedDevice({
    tunnelId,
    publicKey,
    name,
    userAgent,
  });
  if (!registered) {
    res.status(400).json({ error: 'invalid publicKey' });
    return;
  }
  res.status(201).json(registered);
};
