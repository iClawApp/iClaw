import http from 'node:http';
import * as opaque from '@serenity-kit/opaque';
import { afterAll, describe, expect, it, beforeAll } from 'vitest';

import {
  createE2eTransportSession,
  decodeOpaqueSessionKey,
} from '../../src/services/remoteAccessE2eSession';
import {
  decodeWireEnvelope,
  decryptE2eRecord,
  deriveE2eSessionKeys,
  encryptE2eRecord,
  encodeWireEnvelope,
  E2eCounterLedger,
  relayAccessBindingFromAccessToken,
} from '../../src/services/remoteAccessE2eCrypto';
import { handleE2eHttpFrame } from '../../src/services/remoteAccessE2eTransport';
import { generateAccessToken } from '../../src/services/remoteAccessToken';

describe('remoteAccessE2eTransport', () => {
  const tunnelId = 't-e2e-transport';
  const accessToken = generateAccessToken();
  let opaqueSessionKey = '';
  let loopbackPort = 0;
  let loopbackServer: http.Server;

  beforeAll(async () => {
    loopbackServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('tunnel-ok');
    });
    await new Promise<void>((resolve) => {
      loopbackServer.listen(0, '127.0.0.1', () => resolve());
    });
    loopbackPort = (loopbackServer.address() as { port: number }).port;

    await opaque.ready;
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    const password = 'amber-apple-arrow-aspen-888';
    const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
      password,
    });
    const { registrationResponse } = opaque.server.createRegistrationResponse({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: tunnelId,
      registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState,
      registrationResponse,
      password,
    });
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
    const { loginResponse, serverLoginState } = opaque.server.startLogin({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: tunnelId,
      registrationRecord,
      startLoginRequest,
    });
    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password,
    });
    if (!clientResult) throw new Error('opaque login failed');
    opaqueSessionKey = clientResult.sessionKey;
    opaque.server.finishLogin({
      serverLoginState,
      finishLoginRequest: clientResult.finishLoginRequest,
    });
  });

  afterAll(() => {
    loopbackServer.close();
  });

  it('HTTP E2E round-trip via handleE2eHttpFrame', async () => {
    const handle = createE2eTransportSession({
      tunnelId,
      raSessionId: 'ra-sess-test',
      opaqueSessionKey,
      accessToken,
    });
    const relayBinding = relayAccessBindingFromAccessToken(accessToken);
    const keys = deriveE2eSessionKeys(decodeOpaqueSessionKey(opaqueSessionKey), tunnelId, relayBinding);

    const inner = JSON.stringify({
      id: 'req-http-1',
      method: 'GET',
      path: '/',
      headers: { accept: 'text/plain' },
      bodyB64: '',
    });
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 'req-http-1',
      ctr: 0,
      kind: 'http-req',
      inner: new TextEncoder().encode(inner),
      relayBinding,
    });
    const wire = encodeWireEnvelope({
      sid: handle,
      ctr: 0,
      kind: 'http-req',
      streamId: 'req-http-1',
      ciphertext: ct,
    });

    const result = await handleE2eHttpFrame({
      tunnelId,
      bodyRaw: wire,
      localHost: '127.0.0.1',
      localPort: loopbackPort,
    });

    expect(result.status).toBe(200);
    const outWire = decodeWireEnvelope(result.body);
    expect(outWire?.kind).toBe('http-res');
    expect(outWire?.sid).toBe(handle);
    expect(result.body).not.toContain('iclaw_ra');
    expect(result.body).not.toContain('tunnel-ok');
  });

  it('re-attaches the session cookie at loopback so inner requests pass the gate (H1)', async () => {
    // A loopback target that mimics the gate middleware: 200 only when the
    // request carries the right iclaw_ra session cookie, 401 otherwise. The
    // encrypted inner request never carries it (HttpOnly is invisible to JS),
    // so this only succeeds if the transport layer injects it server-side.
    const gated = http.createServer((req, res) => {
      const cookie = req.headers.cookie ?? '';
      if (cookie.includes('iclaw_ra=ra-sess-inject')) {
        res.statusCode = 200;
        res.end('workspace');
      } else {
        res.statusCode = 401;
        res.end('gate');
      }
    });
    await new Promise<void>((resolve) => gated.listen(0, '127.0.0.1', () => resolve()));
    const gatedPort = (gated.address() as { port: number }).port;

    try {
      const handle = createE2eTransportSession({
        tunnelId: `${tunnelId}-inject`,
        raSessionId: 'ra-sess-inject',
        opaqueSessionKey,
        accessToken,
      });
      const relayBinding = relayAccessBindingFromAccessToken(accessToken);
      const keys = deriveE2eSessionKeys(
        decodeOpaqueSessionKey(opaqueSessionKey),
        `${tunnelId}-inject`,
        relayBinding,
      );
      const inner = new TextEncoder().encode(
        JSON.stringify({
          id: 'inj-1',
          method: 'GET',
          path: '/',
          // No cookie here — exactly what the browser's encrypted inner request
          // looks like (the HttpOnly iclaw_ra is not in document.cookie).
          headers: { accept: 'text/html' },
          bodyB64: '',
        }),
      );
      const ct = encryptE2eRecord(keys, 'c2s', {
        tunnelId: `${tunnelId}-inject`,
        streamId: 'inj-1',
        ctr: 0,
        kind: 'http-req',
        inner,
        relayBinding,
      });
      const wire = encodeWireEnvelope({
        sid: handle,
        ctr: 0,
        kind: 'http-req',
        streamId: 'inj-1',
        ciphertext: ct,
      });

      const result = await handleE2eHttpFrame({
        tunnelId: `${tunnelId}-inject`,
        bodyRaw: wire,
        localHost: '127.0.0.1',
        localPort: gatedPort,
      });
      expect(result.status).toBe(200);

      const outWire = decodeWireEnvelope(result.body);
      expect(outWire).toBeTruthy();
      const plain = decryptE2eRecord(
        keys,
        's2c',
        {
          tunnelId: `${tunnelId}-inject`,
          streamId: outWire!.streamId,
          ctr: outWire!.ctr,
          kind: outWire!.kind,
          ciphertext: outWire!.ciphertext,
          relayBinding,
        },
        new E2eCounterLedger(),
      );
      expect(plain).toBeTruthy();
      const innerRes = JSON.parse(new TextDecoder().decode(plain!.inner)) as {
        status: number;
        bodyB64: string;
      };
      // 200 = the loopback saw the injected session cookie (gate passed).
      expect(innerRes.status).toBe(200);
      expect(Buffer.from(innerRes.bodyB64, 'base64').toString('utf8')).toBe('workspace');
    } finally {
      gated.close();
    }
  });

  it('rejects replayed wire counter', async () => {
    const handle = createE2eTransportSession({
      tunnelId: `${tunnelId}-replay`,
      raSessionId: 'ra-sess-replay',
      opaqueSessionKey,
      accessToken,
    });
    const relayBinding = relayAccessBindingFromAccessToken(accessToken);
    const keys = deriveE2eSessionKeys(
      decodeOpaqueSessionKey(opaqueSessionKey),
      `${tunnelId}-replay`,
      relayBinding,
    );
    const inner = new TextEncoder().encode(
      JSON.stringify({
        id: 'r1',
        method: 'GET',
        path: '/',
        headers: {},
        bodyB64: '',
      }),
    );
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId: `${tunnelId}-replay`,
      streamId: 's-replay',
      ctr: 0,
      kind: 'http-req',
      inner,
      relayBinding,
    });
    const wire = encodeWireEnvelope({
      sid: handle,
      ctr: 0,
      kind: 'http-req',
      streamId: 's-replay',
      ciphertext: ct,
    });

    await handleE2eHttpFrame({
      tunnelId: `${tunnelId}-replay`,
      bodyRaw: wire,
      localHost: '127.0.0.1',
      localPort: loopbackPort,
    });
    const replay = await handleE2eHttpFrame({
      tunnelId: `${tunnelId}-replay`,
      bodyRaw: wire,
      localHost: '127.0.0.1',
      localPort: loopbackPort,
    });
    expect(replay.status).toBe(400);
  });
});
