import * as opaque from '@serenity-kit/opaque';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../../src/db/database';
import {
  disableGate,
  enableGate,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
  TUNNEL_ID_HEADER,
  remoteAccessLoginHandler,
} from '../../src/services/remoteAccessAuth';
import { remoteAccess } from '../../src/services/remoteAccess';
import {
  assertOpaqueServerSetup,
  ensureOpaqueReady,
  getOpaqueRegistrationRecord,
  registerOpaqueForTunnel,
  saveOpaqueRegistrationRecord,
} from '../../src/services/remoteAccessOpaque';
import {
  remoteAccessOpaqueLoginFinishHandler,
  remoteAccessOpaqueLoginStartHandler,
} from '../../src/services/remoteAccessOpaqueAuth';
import { remoteAccessState } from '../../src/services/remoteAccessState';

const TUNNEL = 't-opaque-gate01';
const PASS = 'amber-apple-arrow-aspen-777';

function tunneledReq(
  path: string,
  body: Record<string, unknown>,
  method = 'POST',
): Parameters<typeof remoteAccessLoginHandler>[0] {
  return {
    method,
    path,
    ip: '127.0.0.1',
    headers: {
      [TUNNELED_HEADER]: TUNNELED_VALUE,
      [TUNNEL_ID_HEADER]: TUNNEL,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body,
  } as Parameters<typeof remoteAccessLoginHandler>[0];
}

type MockRes = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): void;
  type(mime: string): MockRes;
  send(payload: unknown): void;
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
    type() {
      return res;
    },
    send(payload: unknown) {
      state.body = payload;
      return;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
  };
  return res;
}

async function runOpaqueClientLogin(password: string): Promise<{
  startLoginRequest: string;
  finishLoginRequest: string;
  loginStateId: string;
}> {
  await ensureOpaqueReady();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const startRes = mockRes();
  await remoteAccessOpaqueLoginStartHandler(
    tunneledReq('/__ra/opaque/login/start', { startLoginRequest }),
    startRes as never,
    () => undefined,
  );
  expect(startRes.statusCode).toBe(200);
  const { loginResponse, loginStateId } = startRes.body as {
    loginResponse: string;
    loginStateId: string;
  };
  const clientResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
  });
  if (!clientResult) throw new Error('client finishLogin failed');
  return {
    startLoginRequest,
    finishLoginRequest: clientResult.finishLoginRequest,
    loginStateId,
  };
}

describe('remoteAccessOpaqueGate', () => {
  const envBackup = { ...process.env };

  beforeAll(async () => {
    await ensureOpaqueReady();
  });

  beforeEach(async () => {
    process.env = { ...envBackup };
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    db.exec('DELETE FROM remote_access_devices');
    remoteAccessState.delete(TUNNEL);
    disableGate(TUNNEL);
    const now = Date.now();
    remoteAccessState.save({
      id: TUNNEL,
      label: 'Gate test',
      passphrase: PASS,
      accessToken: 'a'.repeat(43),
      durationMs: 30 * 60_000,
      startedAt: now,
      expiresAt: now + 30 * 60_000,
      createdAt: now,
    });
    const record = await registerOpaqueForTunnel(TUNNEL, PASS);
    saveOpaqueRegistrationRecord(TUNNEL, record);
    enableGate(TUNNEL, PASS);
    remoteAccess.configure({
      relayUrl: 'ws://127.0.0.1:4100/tunnel',
      localHost: '127.0.0.1',
      localPort: 3000,
    });
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('tunneled plain /__ra/login is rejected with 426', () => {
    const res = mockRes();
    remoteAccessLoginHandler(
      tunneledReq('/__ra/login', { passphrase: PASS, next: '/' }),
      res as never,
      () => undefined,
    );
    expect(res.statusCode).toBe(426);
    expect((res.body as { login: string }).login).toBe('opaque');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(PASS);
  });

  it('OPAQUE finish returns a transport handle and does NOT leak iclaw_ra to the browser', async () => {
    const { finishLoginRequest, loginStateId } = await runOpaqueClientLogin(PASS);
    const finishRes = mockRes();
    await remoteAccessOpaqueLoginFinishHandler(
      tunneledReq('/__ra/opaque/login/finish', {
        loginStateId,
        finishLoginRequest,
        next: '/',
      }),
      finishRes as never,
      () => undefined,
    );
    expect(finishRes.statusCode).toBe(200);
    expect((finishRes.body as { ok: boolean }).ok).toBe(true);
    // E2E-only: the session id is NOT handed to the browser as a cookie (that
    // would leak it to the relay). Inner encrypted requests authenticate via
    // the transport session re-attaching the cookie server-side at loopback.
    expect(String(finishRes.headers['Set-Cookie'] ?? '')).not.toContain('iclaw_ra=');
    expect(typeof (finishRes.body as { transportHandle?: unknown }).transportHandle).toBe('string');
  });

  it('wrong passphrase fails OPAQUE login', async () => {
    await ensureOpaqueReady();
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
      password: 'totally-wrong-passphrase-value',
    });
    const startRes = mockRes();
    await remoteAccessOpaqueLoginStartHandler(
      tunneledReq('/__ra/opaque/login/start', { startLoginRequest }),
      startRes as never,
      () => undefined,
    );
    expect(startRes.statusCode).toBe(200);
    const { loginResponse, loginStateId } = startRes.body as {
      loginResponse: string;
      loginStateId: string;
    };
    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: 'totally-wrong-passphrase-value',
    });
    expect(clientResult).toBeFalsy();

    const finishRes = mockRes();
    await remoteAccessOpaqueLoginFinishHandler(
      tunneledReq('/__ra/opaque/login/finish', {
        loginStateId,
        finishLoginRequest: 'invalid-opaque-finish-blob',
      }),
      finishRes as never,
      () => undefined,
    );
    expect(finishRes.statusCode).toBe(401);
  });

  it('OPAQUE wire bodies never contain raw passphrase', async () => {
    const { startLoginRequest } = await runOpaqueClientLogin(PASS);
    expect(startLoginRequest).not.toContain(PASS);
    expect(JSON.stringify({ startLoginRequest })).not.toContain(PASS);
  });

  it('service layer requires a setup when none is configured (API route auto-provisions)', async () => {
    // With no env override and nothing persisted, the low-level service refuses
    // (the HTTP route is what lazily generates+persists one — see
    // ensureOpaqueServerSetup / POST /api/remote-access/tunnels).
    delete process.env.OPAQUE_SERVER_SETUP;
    db.exec("DELETE FROM iclaw_kv WHERE key = 'opaque_server_setup'");
    expect(() => assertOpaqueServerSetup()).toThrow(/OPAQUE server setup/i);
    await expect(
      remoteAccess.createTunnel(30 * 60_000, 'should-fail'),
    ).rejects.toThrow(/OPAQUE server setup/i);
  });

  it('createTunnel registers opaque record', async () => {
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    const status = await remoteAccess.createTunnel(30 * 60_000, 'e2e-tunnel');
    expect(status.id).toBeTruthy();
    const record = getOpaqueRegistrationRecord(status.id);
    expect(record).toBeTruthy();
    expect(record!.length).toBeGreaterThan(10);
    remoteAccess.deleteTunnel(status.id);
  });
});
