/**
 * In-memory E2E transport sessions (keys derived from OPAQUE sessionKey).
 */

import { randomBytes } from 'node:crypto';

import {
  deriveE2eSessionKeys,
  E2eCounterLedger,
  E2eSessionKeys,
  relayAccessBindingFromAccessToken,
} from './remoteAccessE2eCrypto';

export interface E2eTransportSession {
  handle: string;
  tunnelId: string;
  raSessionId: string;
  keys: E2eSessionKeys;
  relayBinding: Uint8Array;
  c2sLedger: E2eCounterLedger;
  /** Next outbound s2c counter per streamId. */
  s2cCtr: Map<string, number>;
}

const byHandle = new Map<string, E2eTransportSession>();
const handleByRaSession = new Map<string, string>();

export function decodeOpaqueSessionKey(sessionKey: string): Uint8Array {
  const buf = Buffer.from(sessionKey, 'base64');
  if (buf.length !== 64) {
    throw new Error('invalid OPAQUE sessionKey length');
  }
  return new Uint8Array(buf);
}

export function createE2eTransportSession(opts: {
  tunnelId: string;
  raSessionId: string;
  opaqueSessionKey: string;
  accessToken: string;
}): string {
  const existing = handleByRaSession.get(opts.raSessionId);
  if (existing) {
    byHandle.delete(existing);
    handleByRaSession.delete(opts.raSessionId);
  }

  const handle = randomBytes(18).toString('base64url');
  const opaqueKey = decodeOpaqueSessionKey(opts.opaqueSessionKey);
  const relayBinding = relayAccessBindingFromAccessToken(opts.accessToken);
  const keys = deriveE2eSessionKeys(opaqueKey, opts.tunnelId, relayBinding);

  const session: E2eTransportSession = {
    handle,
    tunnelId: opts.tunnelId,
    raSessionId: opts.raSessionId,
    keys,
    relayBinding,
    c2sLedger: new E2eCounterLedger(),
    s2cCtr: new Map(),
  };
  byHandle.set(handle, session);
  handleByRaSession.set(opts.raSessionId, handle);
  return handle;
}

export function getE2eTransportSession(handle: string): E2eTransportSession | null {
  return byHandle.get(handle) ?? null;
}

export function nextS2cCounter(session: E2eTransportSession, streamId: string): number {
  const n = session.s2cCtr.get(streamId) ?? 0;
  session.s2cCtr.set(streamId, n + 1);
  return n;
}

export function clearE2eTransportForTunnel(tunnelId: string): void {
  for (const [handle, rec] of byHandle) {
    if (rec.tunnelId === tunnelId) {
      byHandle.delete(handle);
      handleByRaSession.delete(rec.raSessionId);
    }
  }
}

export function clearE2eTransportForRaSession(raSessionId: string): void {
  const handle = handleByRaSession.get(raSessionId);
  if (!handle) return;
  byHandle.delete(handle);
  handleByRaSession.delete(raSessionId);
}
