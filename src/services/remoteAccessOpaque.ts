/**
 * OPAQUE (RFC 9807) for Remote Access — passphrase never sent over the tunnel.
 */

import { createHash, randomBytes } from 'node:crypto';

import * as opaque from '@serenity-kit/opaque';

import { db } from '../db/database';

let readyPromise: Promise<void> | null = null;

const OPAQUE_FP_KV_KEY = 'opaque_server_setup_sha256';
const OPAQUE_SETUP_KV_KEY = 'opaque_server_setup';

const GET_KV = db.prepare<[string], { value: string } | undefined>(
  'SELECT value FROM iclaw_kv WHERE key = ?',
);
const SET_KV = db.prepare(
  'INSERT INTO iclaw_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
const CLEAR_ALL_OPAQUE = db.prepare(
  'UPDATE remote_access_tunnels SET opaque_registration_record = NULL',
);

export async function ensureOpaqueReady(): Promise<void> {
  if (!readyPromise) readyPromise = opaque.ready;
  await readyPromise;
}

/**
 * Resolve the OPAQUE server setup. Precedence:
 *   1. OPAQUE_SERVER_SETUP env override (advanced / shared-host scenarios),
 *   2. the value auto-generated and persisted in the local DB.
 * Returns null only on a fresh install that hasn't created a tunnel yet —
 * `ensureOpaqueServerSetup()` mints and stores one on demand at that point.
 */
function loadServerSetup(): string | null {
  const fromEnv = process.env.OPAQUE_SERVER_SETUP?.trim();
  if (fromEnv) return fromEnv;
  const stored = GET_KV.get(OPAQUE_SETUP_KV_KEY)?.value?.trim();
  return stored && stored.length > 0 ? stored : null;
}

export function assertOpaqueServerSetup(): void {
  if (!loadServerSetup()) {
    throw new Error('OPAQUE server setup is not available for Remote Access');
  }
}

function getServerSetup(): string {
  const setup = loadServerSetup();
  if (!setup) throw new Error('OPAQUE server setup is not available');
  return setup;
}

/**
 * Lazily ensure an OPAQUE server setup exists — generated and persisted the
 * first time a tunnel is created, so a fresh install needs zero manual config.
 * The env override always wins. Stored in the local SQLite (same trust level
 * as the passphrases and access tokens already kept there). Keep it stable:
 * changing it invalidates existing tunnels' OPAQUE registration records.
 */
let setupEnsure: Promise<string> | null = null;
export function ensureOpaqueServerSetup(): Promise<string> {
  const existing = loadServerSetup();
  if (existing) return Promise.resolve(existing);
  if (!setupEnsure) {
    setupEnsure = (async () => {
      await ensureOpaqueReady();
      const again = loadServerSetup(); // a concurrent caller may have won
      if (again) return again;
      const setup = opaque.server.createSetup();
      SET_KV.run(OPAQUE_SETUP_KV_KEY, setup);
      console.log('[remote-access] generated a fresh OPAQUE server setup (stored locally)');
      return setup;
    })().finally(() => {
      setupEnsure = null;
    });
  }
  return setupEnsure;
}

function opaqueSetupFingerprint(): string {
  return createHash('sha256').update(getServerSetup()).digest('hex');
}

/**
 * When OPAQUE_SERVER_SETUP changes, stale registration records cause "Wrong passphrase".
 * Clear and re-register all persisted tunnels against the current setup.
 */
export async function syncOpaqueRegistrationsWithServerSetup(
  tunnels: ReadonlyArray<{ id: string; passphrase: string }>,
): Promise<void> {
  if (tunnels.length === 0) return;
  assertOpaqueServerSetup();
  await ensureOpaqueReady();

  const fp = opaqueSetupFingerprint();
  const prev = GET_KV.get(OPAQUE_FP_KV_KEY)?.value;
  if (prev === fp) {
    await Promise.all(
      tunnels.map((t) => ensureOpaqueRegistrationForTunnel(t.id, t.passphrase)),
    );
    return;
  }

  CLEAR_ALL_OPAQUE.run();
  SET_KV.run(OPAQUE_FP_KV_KEY, fp);
  if (prev) {
    console.warn(
      '[remote-access] OPAQUE_SERVER_SETUP changed — re-registering OPAQUE credentials for active tunnels',
    );
  }

  await Promise.all(tunnels.map((t) => forceOpaqueRegistrationForTunnel(t.id, t.passphrase)));
}

/** Register OPAQUE server record for a tunnel (skips if record exists for current setup). */
export async function ensureOpaqueRegistrationForTunnel(
  tunnelId: string,
  passphrase: string,
): Promise<void> {
  if (getOpaqueRegistrationRecord(tunnelId)) return;
  await forceOpaqueRegistrationForTunnel(tunnelId, passphrase);
}

export async function forceOpaqueRegistrationForTunnel(
  tunnelId: string,
  passphrase: string,
): Promise<void> {
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
  // Used as the lookup key for in-flight OPAQUE server login state. Must be
  // unguessable: Math.random() is not cryptographically secure, so derive the
  // id from CSPRNG bytes instead.
  return `ol-${randomBytes(18).toString('base64url')}`;
}
