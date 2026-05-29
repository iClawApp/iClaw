import * as opaque from '@serenity-kit/opaque';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  disableGate,
  enableGate,
  mintSession,
  renderGateLoginPage,
  remoteAccessAuthMiddleware,
  SESSION_COOKIE,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
  TUNNEL_ID_HEADER,
} from '../../src/services/remoteAccessAuth';
import {
  E2E_HTTP_PATH,
  isE2ePlaintextTunnelExempt,
} from '../../src/services/remoteAccessE2eTransport';
import {
  deriveE2eSessionKeys,
  encryptE2eRecord,
  encodeWireEnvelope,
  relayAccessBindingFromAccessToken,
} from '../../src/services/remoteAccessE2eCrypto';
import { generateAccessToken } from '../../src/services/remoteAccessToken';

const TUNNEL = 't-plaintext-exempt';

function captureContainsAppSecrets(frameOrText: string): boolean {
  let text = frameOrText;
  try {
    const frame = JSON.parse(frameOrText) as { path?: string; body?: string };
    if (typeof frame.path === 'string') {
      const p = frame.path.split('?')[0] ?? frame.path;
      if (
        /^\/(chats|projects|tasks|settings)(\/|$)/.test(p) &&
        !p.startsWith('/__ra/')
      ) {
        return true;
      }
    }
    if (typeof frame.body === 'string' && frame.body.length > 0) {
      text += Buffer.from(frame.body, 'base64').toString('utf8');
    }
  } catch {
    // not JSON
  }
  return (
    /"chatId"\s*:/.test(text) ||
    /"projectId"\s*:/.test(text) ||
    /"type"\s*:\s*"message-appended"/.test(text)
  );
}

function relayReqFrame(opts: {
  method: string;
  path: string;
  body?: string;
  cookie?: string;
}): string {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return JSON.stringify({
    t: 'req',
    tunnelId: TUNNEL,
    method: opts.method,
    path: opts.path,
    headers,
    body: opts.body ? Buffer.from(opts.body, 'utf8').toString('base64') : '',
  });
}

describe('Remote Access plaintext tunnel exempt (gate only)', () => {
  beforeEach(() => {
    disableGate(TUNNEL);
    enableGate(TUNNEL, 'amber-apple-arrow-aspen-777');
  });

  afterEach(() => {
    disableGate(TUNNEL);
  });

  it('1. GET / without iclaw_ra is exempt; Express serves gate HTML', () => {
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/',
        tunnelId: TUNNEL,
      }),
    ).toBe(true);

    const gateHtml = renderGateLoginPage({ tunnelId: TUNNEL, next: '/' });
    expect(gateHtml).toContain('ra-gate-page');
    expect(captureContainsAppSecrets(gateHtml)).toBe(false);

    const res = { statusCode: 0, body: '' as unknown };
    const mockRes = {
      get statusCode() {
        return res.statusCode;
      },
      get body() {
        return res.body;
      },
      status(code: number) {
        res.statusCode = code;
        return mockRes;
      },
      type() {
        return mockRes;
      },
      send(payload: unknown) {
        res.body = payload;
      },
    };
    remoteAccessAuthMiddleware(
      {
        method: 'GET',
        path: '/',
        originalUrl: '/',
        headers: {
          [TUNNELED_HEADER]: TUNNELED_VALUE,
          [TUNNEL_ID_HEADER]: TUNNEL,
        },
      } as never,
      mockRes as never,
      () => undefined,
    );
    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('ra-gate-page');
  });

  it('2. GET / with valid iclaw_ra is not plaintext-exempt', () => {
    const sid = mintSession(TUNNEL);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sid)}`;
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/',
        tunnelId: TUNNEL,
        cookieHeader: cookie,
      }),
    ).toBe(false);
  });

  it('3. authenticated workspace paths blocked; E2E HTTP path allowed', () => {
    const sid = mintSession(TUNNEL);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sid)}`;
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/chats/x',
        tunnelId: TUNNEL,
        cookieHeader: cookie,
      }),
    ).toBe(false);
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'POST',
        path: E2E_HTTP_PATH,
        tunnelId: TUNNEL,
        cookieHeader: cookie,
      }),
    ).toBe(true);
  });

  it('4. relay capture: chat JSON not in allowed plaintext; encrypted frame ok', async () => {
    await opaque.ready;
    const binding = relayAccessBindingFromAccessToken(generateAccessToken());
    const keys = deriveE2eSessionKeys(new Uint8Array(64).fill(4), TUNNEL, binding);
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId: TUNNEL,
      streamId: 's1',
      ctr: 0,
      kind: 'http-req',
      inner: new TextEncoder().encode('{"method":"GET","path":"/chats/1"}'),
      relayBinding: binding,
    });
    const wire = encodeWireEnvelope({
      sid: 'h1',
      ctr: 0,
      kind: 'http-req',
      streamId: 's1',
      ciphertext: ct,
    });
    const encryptedFrame = relayReqFrame({ method: 'POST', path: E2E_HTTP_PATH, body: wire });
    expect(captureContainsAppSecrets(encryptedFrame)).toBe(false);

    const badPlain = relayReqFrame({
      method: 'GET',
      path: '/chats/1',
      body: '{"chatId":"leaked"}',
    });
    expect(captureContainsAppSecrets(badPlain)).toBe(true);

    const gateOnly = relayReqFrame({
      method: 'GET',
      path: '/',
      body: renderGateLoginPage({ tunnelId: TUNNEL }),
    });
    expect(captureContainsAppSecrets(gateOnly)).toBe(false);
  });
});
