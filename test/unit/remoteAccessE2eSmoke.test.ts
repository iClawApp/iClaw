import { describe, expect, it } from 'vitest';
import * as opaque from '@serenity-kit/opaque';

import {
  looksLikeE2eWireEnvelope,
  scanRelayCaptureText,
} from '../../src/services/remoteAccessCaptureScan';
import {
  decodeWireEnvelope,
  deriveE2eSessionKeys,
  encryptE2eRecord,
  encodeWireEnvelope,
  E2eCounterLedger,
  decryptE2eRecord,
  relayAccessBindingFromAccessToken,
} from '../../src/services/remoteAccessE2eCrypto';
import { generateAccessToken } from '../../src/services/remoteAccessToken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Remote Access E2E smoke (alpha)', () => {
  it('capture scanner flags plaintext leaks', () => {
    const bad = scanRelayCaptureText(
      JSON.stringify({
        t: 'req',
        method: 'POST',
        path: '/__ra/login',
        body: Buffer.from(JSON.stringify({ passphrase: 'amber-apple' })).toString('base64'),
        headers: { cookie: 'iclaw_ra=supersecret123456' },
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.hits.length).toBeGreaterThan(0);
  });

  it('capture scanner accepts E2E wire envelope', () => {
    const tunnelId = 't-smoke';
    const access = generateAccessToken();
    const binding = relayAccessBindingFromAccessToken(access);
    const keys = deriveE2eSessionKeys(new Uint8Array(64).fill(3), tunnelId, binding);
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 's1',
      ctr: 0,
      kind: 'http-req',
      inner: new TextEncoder().encode('{"method":"GET","path":"/"}'),
      relayBinding: binding,
    });
    const wire = encodeWireEnvelope({
      sid: 'handle-smoke01',
      ctr: 0,
      kind: 'http-req',
      streamId: 's1',
      ciphertext: ct,
    });
    const frame = JSON.stringify({
      t: 'req',
      method: 'POST',
      path: '/__ra/e2e/http',
      headers: {},
      body: Buffer.from(wire, 'utf8').toString('base64'),
    });
    const good = scanRelayCaptureText(frame);
    expect(good.ok).toBe(true);
    expect(looksLikeE2eWireEnvelope(wire)).toBe(true);
  });

  it('replayed E2E frame fails decrypt', () => {
    const tunnelId = 't-smoke-replay';
    const binding = relayAccessBindingFromAccessToken('token-for-smoke-test-only');
    const keys = deriveE2eSessionKeys(new Uint8Array(64).fill(9), tunnelId, binding);
    const ledger = new E2eCounterLedger();
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 's-r',
      ctr: 0,
      kind: 'http-req',
      inner: new Uint8Array([1]),
      relayBinding: binding,
    });
    const ok1 = decryptE2eRecord(
      keys,
      'c2s',
      {
        tunnelId,
        streamId: 's-r',
        ctr: 0,
        kind: 'http-req',
        ciphertext: ct,
        relayBinding: binding,
      },
      ledger,
    );
    expect(ok1).toBeTruthy();
    const ok2 = decryptE2eRecord(
      keys,
      'c2s',
      {
        tunnelId,
        streamId: 's-r',
        ctr: 0,
        kind: 'http-req',
        ciphertext: ct,
        relayBinding: binding,
      },
      ledger,
    );
    expect(ok2).toBeNull();
  });

  it('OPAQUE wrong passphrase fails client finish', async () => {
    await opaque.ready;
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    const tid = 't-smoke-wrong';
    const pw = 'correct-passphrase-smoke';
    const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
      password: pw,
    });
    const { registrationResponse } = opaque.server.createRegistrationResponse({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: tid,
      registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState,
      registrationResponse,
      password: pw,
    });
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
      password: 'wrong-passphrase-smoke',
    });
    const { loginResponse } = await opaque.server.startLogin({
      serverSetup: process.env.OPAQUE_SERVER_SETUP,
      userIdentifier: tid,
      registrationRecord,
      startLoginRequest,
    });
    const clientResult = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: 'wrong-passphrase-smoke',
    });
    expect(clientResult).toBeFalsy();
  });

  it('gate JS avoids plain tunneled login', () => {
    const js = fs.readFileSync(path.join(pkgRoot, 'public/js/ra-device-auth.js'), 'utf8');
    expect(js).toContain('runOpaqueLogin');
    const transport = fs.readFileSync(path.join(pkgRoot, 'public/js/ra-e2e-transport.mjs'), 'utf8');
    expect(transport).toContain('/__ra/e2e/http');
    expect(transport).not.toMatch(/postJson\(['"]\/__ra\/login/);
  });

  it('wire decode includes sid', () => {
    const w = encodeWireEnvelope({
      sid: 'h1',
      ctr: 1,
      kind: 'ws-data',
      streamId: 'ws1',
      ciphertext: new Uint8Array([5, 6]),
    });
    expect(decodeWireEnvelope(w)?.sid).toBe('h1');
  });
});
