/**
 * Browser ↔ server E2E crypto interop (Step 4 — the "crypto.subtle" coverage).
 *
 * Loads the REAL browser crypto module (public/js/ra-e2e-crypto.mjs) — the one
 * shipped to visitors — in Node, with its vendored noble imports rewritten to
 * the on-disk files and AES-GCM running through the WebCrypto `crypto.subtle`
 * available in modern Node. It then proves byte-level compatibility with the
 * server implementation (src/services/remoteAccessE2eCrypto.ts):
 *
 *   - identical session-key derivation (HKDF) from the same inputs,
 *   - browser-encrypted (c2s) records decrypt on the server,
 *   - server-encrypted (s2c) records decrypt in the browser,
 *   - the C1 per-stream subkey holds across implementations,
 *   - wire envelopes round-trip both ways.
 *
 * The Node integration test (scripts/ra-e2e-integration.mjs) stands in for the
 * server data path; this test closes the gap on the actual browser code so a
 * drift between the two crypto files fails CI instead of breaking real visitors.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import * as server from '../../src/services/remoteAccessE2eCrypto';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserSrcPath = path.join(pkgRoot, 'public/js/ra-e2e-crypto.mjs');
const nobleDirUrl = pathToFileURL(path.join(pkgRoot, 'public/js/vendor/noble') + '/').href;

type BrowserCrypto = typeof import('../../public/js/ra-e2e-crypto.mjs');
let browser: BrowserCrypto;
let tmpFile: string;

beforeAll(async () => {
  // Rewrite the two absolute browser import paths to the on-disk vendored
  // files; noble's own relative imports then resolve from their real location.
  const src = fs
    .readFileSync(browserSrcPath, 'utf8')
    .split('/js/vendor/noble/')
    .join(nobleDirUrl);
  tmpFile = path.join(os.tmpdir(), `ra-e2e-crypto-browser-interop-${process.pid}.mjs`);
  fs.writeFileSync(tmpFile, src);
  browser = (await import(pathToFileURL(tmpFile).href)) as BrowserCrypto;
});

const TUNNEL = 't-interop';
const ACCESS = 'a'.repeat(43);
const binding = server.relayAccessBindingFromAccessToken(ACCESS);
const opaqueBytes = new Uint8Array(64);
for (let i = 0; i < opaqueBytes.length; i++) opaqueBytes[i] = (i * 7 + 11) & 0xff;
const opaqueB64 = Buffer.from(opaqueBytes).toString('base64url');

describe('browser ↔ server E2E crypto interop', () => {
  it('derives identical session keys from the same inputs', () => {
    const s = server.deriveE2eSessionKeys(opaqueBytes, TUNNEL, binding);
    const b = browser.deriveE2eSessionKeys(opaqueB64, TUNNEL, binding);
    expect(Buffer.from(b.c2s).toString('hex')).toBe(Buffer.from(s.c2s).toString('hex'));
    expect(Buffer.from(b.s2c).toString('hex')).toBe(Buffer.from(s.s2c).toString('hex'));
  });

  it('browser-encrypted c2s record decrypts on the server', async () => {
    const keys = browser.deriveE2eSessionKeys(opaqueB64, TUNNEL, binding);
    const inner = new TextEncoder().encode(JSON.stringify({ method: 'GET', path: '/chat' }));
    const ct = await browser.encryptE2eRecord(keys, 'c2s', {
      tunnelId: TUNNEL,
      streamId: 's-1',
      ctr: 0,
      kind: 'http-req',
      inner,
      relayBinding: binding,
    });
    const sKeys = server.deriveE2eSessionKeys(opaqueBytes, TUNNEL, binding);
    const rec = server.decryptE2eRecord(
      sKeys,
      'c2s',
      {
        tunnelId: TUNNEL,
        streamId: 's-1',
        ctr: 0,
        kind: 'http-req',
        ciphertext: ct,
        relayBinding: binding,
      },
      new server.E2eCounterLedger(),
    );
    expect(rec).toBeTruthy();
    expect(new TextDecoder().decode(rec!.inner)).toBe('{"method":"GET","path":"/chat"}');
  });

  it('server-encrypted s2c record decrypts in the browser', async () => {
    const sKeys = server.deriveE2eSessionKeys(opaqueBytes, TUNNEL, binding);
    const inner = new TextEncoder().encode(JSON.stringify({ status: 200, bodyB64: '' }));
    const ct = server.encryptE2eRecord(sKeys, 's2c', {
      tunnelId: TUNNEL,
      streamId: 's-2',
      ctr: 0,
      kind: 'http-res',
      inner,
      relayBinding: binding,
    });
    const keys = browser.deriveE2eSessionKeys(opaqueB64, TUNNEL, binding);
    const rec = await browser.decryptE2eRecord(
      keys,
      's2c',
      {
        tunnelId: TUNNEL,
        streamId: 's-2',
        ctr: 0,
        kind: 'http-res',
        ciphertext: ct,
        relayBinding: binding,
      },
      new browser.E2eCounterLedger(),
    );
    expect(rec).toBeTruthy();
    expect(new TextDecoder().decode(rec!.inner)).toBe('{"status":200,"bodyB64":""}');
  });

  it('C1: per-stream subkey holds across implementations (no cross-stream decrypt)', async () => {
    const keys = browser.deriveE2eSessionKeys(opaqueB64, TUNNEL, binding);
    const inner = new TextEncoder().encode('x');
    const ctA = await browser.encryptE2eRecord(keys, 'c2s', {
      tunnelId: TUNNEL,
      streamId: 'stream-A',
      ctr: 0,
      kind: 'http-req',
      inner,
      relayBinding: binding,
    });
    const ctB = await browser.encryptE2eRecord(keys, 'c2s', {
      tunnelId: TUNNEL,
      streamId: 'stream-B',
      ctr: 0,
      kind: 'http-req',
      inner,
      relayBinding: binding,
    });
    // Same plaintext + same counter, different stream → different ciphertext.
    expect(Buffer.from(ctA).toString('hex')).not.toBe(Buffer.from(ctB).toString('hex'));

    const sKeys = server.deriveE2eSessionKeys(opaqueBytes, TUNNEL, binding);
    // Server must reject stream-A ciphertext presented under stream-B context.
    const cross = server.decryptE2eRecord(
      sKeys,
      'c2s',
      {
        tunnelId: TUNNEL,
        streamId: 'stream-B',
        ctr: 0,
        kind: 'http-req',
        ciphertext: ctA,
        relayBinding: binding,
      },
      new server.E2eCounterLedger(),
    );
    expect(cross).toBeNull();
  });

  it('wire envelopes round-trip between implementations', () => {
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wireFromBrowser = browser.encodeWireEnvelope({
      sid: 'handle-xyz',
      ctr: 3,
      kind: 'ws-data',
      streamId: 'ws-1',
      ciphertext,
    });
    const decodedByServer = server.decodeWireEnvelope(wireFromBrowser);
    expect(decodedByServer?.sid).toBe('handle-xyz');
    expect(decodedByServer?.ctr).toBe(3);
    expect(decodedByServer?.streamId).toBe('ws-1');
    expect(Buffer.from(decodedByServer!.ciphertext).toString('hex')).toBe('0102030405060708');

    const wireFromServer = server.encodeWireEnvelope({
      sid: 'handle-xyz',
      ctr: 3,
      kind: 'ws-data',
      streamId: 'ws-1',
      ciphertext,
    });
    const decodedByBrowser = browser.decodeWireEnvelope(wireFromServer);
    expect(decodedByBrowser?.sid).toBe('handle-xyz');
    expect(Buffer.from(decodedByBrowser!.ciphertext).toString('hex')).toBe('0102030405060708');
  });
});
