/**
 * Tunneled OPAQUE login routes — passphrase never appears in relay frames.
 * Transport payload encryption is a separate phase; this is E2E password handshake only.
 */

import type { Request, RequestHandler, Response } from 'express';

import {
  attachSessionCookie,
  getTunnelIdFromRequest,
  isGateEnabled,
  isTunneledRequest,
} from './remoteAccessAuth';
import { registerTrustedDevice } from './remoteAccessDeviceAuth';
import { isValidDevicePublicKey } from './remoteAccessDeviceCrypto';
import { createE2eTransportSession } from './remoteAccessE2eSession';
import { remoteAccessState } from './remoteAccessState';
import {
  assertOpaqueServerSetup,
  finishOpaqueLogin,
  getOpaqueRegistrationRecord,
  startOpaqueLogin,
  stashOpaqueLoginState,
  takeOpaqueLoginState,
} from './remoteAccessOpaque';

export const E2E_LOGIN_REQUIRED_MSG =
  'E2E login required — use POST /__ra/opaque/login/start and /__ra/opaque/login/finish';

const OPAQUE_START_PATH = '/__ra/opaque/login/start';
const OPAQUE_FINISH_PATH = '/__ra/opaque/login/finish';

export function isOpaqueLoginPath(path: string): boolean {
  return path === OPAQUE_START_PATH || path === OPAQUE_FINISH_PATH;
}

function rejectNotTunneled(res: Response): void {
  res.status(404).type('text/plain').send('not found');
}

function tunnelContext(req: Request): { tunnelId: string } | null {
  if (!isTunneledRequest(req)) return null;
  const tunnelId = getTunnelIdFromRequest(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) return null;
  return { tunnelId };
}

export const remoteAccessOpaqueLoginStartHandler: RequestHandler = async (req, res) => {
  const ctx = tunnelContext(req);
  if (!ctx) {
    rejectNotTunneled(res);
    return;
  }

  const startLoginRequest =
    typeof req.body?.startLoginRequest === 'string' ? req.body.startLoginRequest : '';
  if (!startLoginRequest) {
    res.status(400).json({ error: 'startLoginRequest required' });
    return;
  }

  try {
    assertOpaqueServerSetup();
  } catch (err) {
    res.status(503).json({
      error: err instanceof Error ? err.message : 'OPAQUE_SERVER_SETUP missing',
    });
    return;
  }

  let registrationRecord = getOpaqueRegistrationRecord(ctx.tunnelId);
  if (!registrationRecord) {
    res.status(503).json({
      error: 'OPAQUE registration missing for this tunnel — recreate tunnel or restart iClaw',
    });
    return;
  }

  try {
    const { loginResponse, serverLoginState } = await startOpaqueLogin(
      ctx.tunnelId,
      registrationRecord,
      startLoginRequest,
    );
    const loginStateId = stashOpaqueLoginState(ctx.tunnelId, serverLoginState);
    res.json({ loginResponse, loginStateId });
  } catch {
    res.status(400).json({ error: 'invalid OPAQUE startLoginRequest' });
  }
};

export const remoteAccessOpaqueLoginFinishHandler: RequestHandler = async (req, res) => {
  const ctx = tunnelContext(req);
  if (!ctx) {
    rejectNotTunneled(res);
    return;
  }

  const loginStateId =
    typeof req.body?.loginStateId === 'string' ? req.body.loginStateId : '';
  const finishLoginRequest =
    typeof req.body?.finishLoginRequest === 'string' ? req.body.finishLoginRequest : '';
  if (!loginStateId || !finishLoginRequest) {
    res.status(400).json({ error: 'loginStateId and finishLoginRequest required' });
    return;
  }

  const serverLoginState = takeOpaqueLoginState(loginStateId, ctx.tunnelId);
  if (!serverLoginState) {
    res.status(403).json({ error: 'login state expired or invalid' });
    return;
  }

  const registrationRecord = getOpaqueRegistrationRecord(ctx.tunnelId);
  if (!registrationRecord) {
    res.status(503).json({ error: 'OPAQUE registration missing for this tunnel' });
    return;
  }

  let opaqueSessionKey: string;
  try {
    const result = await finishOpaqueLogin({
      tunnelId: ctx.tunnelId,
      registrationRecord,
      serverLoginState,
      finishLoginRequest,
    });
    opaqueSessionKey = result.sessionKey;
  } catch {
    res.status(401).json({ error: 'OPAQUE login failed' });
    return;
  }

  const raSessionId = attachSessionCookie(res, ctx.tunnelId, req);
  const persisted = remoteAccessState.get(ctx.tunnelId);
  const transportHandle = createE2eTransportSession({
    tunnelId: ctx.tunnelId,
    raSessionId,
    opaqueSessionKey,
    accessToken: persisted?.accessToken ?? '',
  });
  const nextUrl =
    typeof req.body?.next === 'string' && req.body.next.startsWith('/')
      ? req.body.next
      : '/';

  const reg = req.body?.registerDevice as Record<string, unknown> | undefined;
  let deviceId: string | null = null;
  if (reg && typeof reg.publicKey === 'string' && isValidDevicePublicKey(reg.publicKey)) {
    const registered = registerTrustedDevice({
      tunnelId: ctx.tunnelId,
      publicKey: reg.publicKey,
      name: typeof reg.name === 'string' ? reg.name : null,
      userAgent:
        typeof reg.userAgent === 'string'
          ? reg.userAgent
          : (req.headers['user-agent'] ?? '').toString(),
    });
    deviceId = registered?.deviceId ?? null;
  }

  res.json({ ok: true, next: nextUrl, deviceId, transportHandle });
};
