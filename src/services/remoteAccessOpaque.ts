/**
 * OPAQUE (RFC 9807) for Remote Access — passphrase never sent over the tunnel.
 */

import * as opaque from '@serenity-kit/opaque';

import { db } from '../db/database';

let readyPromise: Promise<void> | null = null;

export async function ensureOpaqueReady(): Promise<void> {
  if (!readyPromise) readyPromise = opaque.ready;
  await readyPromise;
}

export function assertOpaqueServerSetup(): void {
  if (!process.env.OPAQUE_SERVER_SETUP?.trim()) {
    throw new Error(
      'OPAQUE_SERVER_SETUP is required for Remote Access. ' +
        'Generate one with: npx @serenity-kit/opaque create-server-setup',
    );
  }
}

function getServerSetup(): string {
  assertOpaqueServerSetup();
  return process.env.OPAQUE_SERVER_SETUP!.trim();
}

/** Register OPAQUE server record for a tunnel (localhost — uses passphrase once). */
export async function ensureOpaqueRegistrationForTunnel(
  tunnelId: string,
  passphrase: string,
): Promise<void> {
  if (getOpaqueRegistrationRecord(tunnelId)) return;
  const record = await registerOpaqueForTunnel(tunnelId, passphrase);
  saveOpaqueRegistrationRecord(tunnelId, record);
}

/** Register OPAQUE credentials for a tunnel (localhost only — uses passphrase once). */
export async function registerOpaqueForTunnel(
  tunnelId: string,
  passphrase: string,
): Promise<string> {
  await ensureOpaqueReady();
  const serverSetup = getServerSetup();
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password: passphrase,
  });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier: tunnelId,
    registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: passphrase,
  });
  return registrationRecord;
}

export async function startOpaqueLogin(
  tunnelId: string,
  registrationRecord: string,
  startLoginRequest: string,
): Promise<{ loginResponse: string; serverLoginState: string }> {
  await ensureOpaqueReady();
  const serverSetup = getServerSetup();
  return opaque.server.startLogin({
    userIdentifier: tunnelId,
    registrationRecord,
    serverSetup,
    startLoginRequest,
  });
}

export async function finishOpaqueLogin(opts: {
  tunnelId: string;
  registrationRecord: string;
  serverLoginState: string;
  finishLoginRequest: string;
}): Promise<{ sessionKey: string }> {
  await ensureOpaqueReady();
  const serverSetup = getServerSetup();
  const result = opaque.server.finishLogin({
    serverLoginState: opts.serverLoginState,
    finishLoginRequest: opts.finishLoginRequest,
  });
  return { sessionKey: result.sessionKey };
}

const GET_OPAQUE = db.prepare<[string], { opaque_registration_record: string | null }>(
  'SELECT opaque_registration_record FROM remote_access_tunnels WHERE id = ?',
);
const SET_OPAQUE = db.prepare(
  'UPDATE remote_access_tunnels SET opaque_registration_record = ? WHERE id = ?',
);

export function getOpaqueRegistrationRecord(tunnelId: string): string | null {
  const row = GET_OPAQUE.get(tunnelId);
  return row?.opaque_registration_record ?? null;
}

export function saveOpaqueRegistrationRecord(tunnelId: string, record: string): void {
  SET_OPAQUE.run(record, tunnelId);
}

/** In-memory server login state between start and finish (tunneled round-trip). */
const pendingOpaqueLogins = new Map<
  string,
  { tunnelId: string; serverLoginState: string; expiresAt: number }
>();

const LOGIN_STATE_TTL_MS = 60_000;

export function stashOpaqueLoginState(
  tunnelId: string,
  serverLoginState: string,
): string {
  const id = opaqueRandomId();
  pendingOpaqueLogins.set(id, {
    tunnelId,
    serverLoginState,
    expiresAt: Date.now() + LOGIN_STATE_TTL_MS,
  });
  return id;
}

export function takeOpaqueLoginState(
  loginStateId: string,
  tunnelId: string,
): string | null {
  const rec = pendingOpaqueLogins.get(loginStateId);
  pendingOpaqueLogins.delete(loginStateId);
  if (!rec || rec.tunnelId !== tunnelId || rec.expiresAt <= Date.now()) return null;
  return rec.serverLoginState;
}

function opaqueRandomId(): string {
  return `ol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
