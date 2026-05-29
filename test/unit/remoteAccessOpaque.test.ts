import { describe, expect, it, beforeAll } from 'vitest';
import * as opaque from '@serenity-kit/opaque';

import {
  ensureOpaqueReady,
  registerOpaqueForTunnel,
  startOpaqueLogin,
  finishOpaqueLogin,
} from '../../src/services/remoteAccessOpaque';

describe('remoteAccessOpaque', () => {
  const tunnelId = 't-opaque-test';
  const password = 'amber-apple-arrow-aspen-999';

  beforeAll(async () => {
    await ensureOpaqueReady();
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
  });

  it('register + login never exposes password in messages', async () => {
    const registrationRecord = await registerOpaqueForTunnel(tunnelId, password);

    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
    expect(startLoginRequest).not.toContain(password);

    const { loginResponse, serverLoginState } = await startOpaqueLogin(
      tunnelId,
      registrationRecord,
      startLoginRequest,
    );
    expect(loginResponse).not.toContain(password);

    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password,
    });
    expect(clientResult).toBeTruthy();
    if (!clientResult) return;

    const serverResult = await finishOpaqueLogin({
      tunnelId,
      registrationRecord,
      serverLoginState,
      finishLoginRequest: clientResult.finishLoginRequest,
    });
    expect(serverResult.sessionKey).toBeTruthy();
    expect(clientResult.sessionKey).toBe(serverResult.sessionKey);
  });

  it('wrong password fails login', async () => {
    const registrationRecord = await registerOpaqueForTunnel(`${tunnelId}-2`, password);
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
      password: 'wrong-password-value',
    });
    const { loginResponse, serverLoginState } = await startOpaqueLogin(
      `${tunnelId}-2`,
      registrationRecord,
      startLoginRequest,
    );
    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: 'wrong-password-value',
    });
    expect(clientResult).toBeFalsy();
  });
});
