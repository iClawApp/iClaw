import * as opaque from '@serenity-kit/opaque';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../../src/db/database';
import { remoteAccessState } from '../../src/services/remoteAccessState';
import {
  ensureOpaqueServerSetup,
  forceOpaqueRegistrationForTunnel,
  getOpaqueRegistrationRecord,
  registerOpaqueForTunnel,
  syncOpaqueRegistrationsWithServerSetup,
} from '../../src/services/remoteAccessOpaque';

const TUNNEL = 't-opaque-fp-sync';

describe('remoteAccessOpaque setup sync', () => {
  const envBackup = process.env.OPAQUE_SERVER_SETUP;

  beforeAll(async () => {
    await opaque.ready;
  });

  afterEach(() => {
    if (envBackup !== undefined) process.env.OPAQUE_SERVER_SETUP = envBackup;
    else delete process.env.OPAQUE_SERVER_SETUP;
    db.exec('DELETE FROM iclaw_kv');
    remoteAccessState.delete(TUNNEL);
  });

  it('re-registers OPAQUE when OPAQUE_SERVER_SETUP changes', async () => {
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    const pw = 'amber-apple-arrow-aspen-fp1';
    const now = Date.now();
    remoteAccessState.save({
      id: TUNNEL,
      label: 'fp',
      passphrase: pw,
      accessToken: 'a'.repeat(43),
      durationMs: 60_000,
      startedAt: now,
      expiresAt: now + 60_000,
      createdAt: now,
    });

    await syncOpaqueRegistrationsWithServerSetup([{ id: TUNNEL, passphrase: pw }]);
    const rec1 = getOpaqueRegistrationRecord(TUNNEL);
    expect(rec1).toBeTruthy();

    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    await syncOpaqueRegistrationsWithServerSetup([{ id: TUNNEL, passphrase: pw }]);
    const rec2 = getOpaqueRegistrationRecord(TUNNEL);
    expect(rec2).toBeTruthy();
    expect(rec2).not.toBe(rec1);

    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: pw });
    const { loginResponse, serverLoginState } = await opaque.server.startLogin({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: TUNNEL,
      registrationRecord: rec2!,
      startLoginRequest,
    });
    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: pw,
    });
    expect(clientResult).toBeTruthy();
    expect(
      await opaque.server.finishLogin({
        serverLoginState,
        finishLoginRequest: clientResult!.finishLoginRequest,
      }),
    ).toBeTruthy();
  });

  it('forceOpaqueRegistrationForTunnel replaces stale record', async () => {
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    const pw = 'amber-apple-arrow-aspen-fp2';
    const stale = await registerOpaqueForTunnel(TUNNEL, 'wrong-passphrase-for-stale');
    remoteAccessState.save({
      id: TUNNEL,
      label: 'fp2',
      passphrase: pw,
      accessToken: 'b'.repeat(43),
      durationMs: 60_000,
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    db.prepare('UPDATE remote_access_tunnels SET opaque_registration_record = ? WHERE id = ?').run(
      stale,
      TUNNEL,
    );

    await forceOpaqueRegistrationForTunnel(TUNNEL, pw);
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: pw });
    const { loginResponse, serverLoginState } = await opaque.server.startLogin({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: TUNNEL,
      registrationRecord: getOpaqueRegistrationRecord(TUNNEL)!,
      startLoginRequest,
    });
    expect(
      opaque.client.finishLogin({
        clientLoginState,
        loginResponse,
        password: pw,
      }),
    ).toBeTruthy();
    expect(
      await opaque.server.finishLogin({
        serverLoginState,
        finishLoginRequest: opaque.client.finishLogin({
          clientLoginState,
          loginResponse,
          password: pw,
        })!.finishLoginRequest,
      }),
    ).toBeTruthy();
  });

  it('auto-generates and persists an OPAQUE setup when none is configured', async () => {
    delete process.env.OPAQUE_SERVER_SETUP;
    db.exec('DELETE FROM iclaw_kv');

    // Nothing in env, nothing persisted → minted on demand.
    const setup1 = await ensureOpaqueServerSetup();
    expect(typeof setup1).toBe('string');
    expect(setup1.length).toBeGreaterThan(20);

    // Persisted in the DB → a second call returns the SAME value (stable, so
    // existing tunnels' OPAQUE records stay valid across restarts).
    const setup2 = await ensureOpaqueServerSetup();
    expect(setup2).toBe(setup1);

    // And it is actually usable for a register round-trip.
    const rec = await registerOpaqueForTunnel(TUNNEL, 'amber-apple-arrow-aspen-auto');
    expect(rec).toBeTruthy();
  });

  it('env override takes precedence over a persisted setup', async () => {
    delete process.env.OPAQUE_SERVER_SETUP;
    db.exec('DELETE FROM iclaw_kv');

    const generated = await ensureOpaqueServerSetup(); // persists to the DB
    const envSetup = opaque.server.createSetup();
    process.env.OPAQUE_SERVER_SETUP = envSetup;

    const resolved = await ensureOpaqueServerSetup();
    expect(resolved).toBe(envSetup);
    expect(resolved).not.toBe(generated);
  });
});
