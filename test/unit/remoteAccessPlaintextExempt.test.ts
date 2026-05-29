import * as opaque from '@serenity-kit/opaque';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  disableGate,
  enableGate,
  mintSession,
  renderGateLoginPage,
  remoteAccessAuthMiddleware,
  SESSION_COOKIE,
  stripSessionCookie,
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

  it('2. GET / is always exempt (gate bootstrap), even with a session cookie', () => {
    // The plaintext path strips the session cookie before this runs; GET / is
    // the entry point and always serves the gate bootstrap (which resumes the
    // E2E session client-side from sessionStorage, or prompts for the
    // passphrase). It never serves the workspace plaintext (middleware sees no
    // session and renders the gate).
    const sid = mintSession(TUNNEL);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sid)}`;
    expect(isE2ePlaintextTunnelExempt({ method: 'GET', path: '/', tunnelId: TUNNEL })).toBe(true);
    expect(
      isE2ePlaintextTunnelExempt({ method: 'GET', path: '/', tunnelId: TUNNEL, cookieHeader: cookie }),
    ).toBe(true);
  });

  it('2b. deep-link navigation serves the gate bootstrap; data XHR is forced to E2E', () => {
    // Reported bug: clicking a chat / reloading a deep link is a top-level
    // HTML navigation to a non-"/" path. It must serve the gate bootstrap
    // (which resumes E2E and loads the page encrypted), NOT the "E2E transport
    // required" JSON dead-end.
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/chats/82',
        tunnelId: TUNNEL,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }),
    ).toBe(true);
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/chats/82',
        tunnelId: TUNNEL,
        secFetchDest: 'document',
      }),
    ).toBe(true);
    // A data XHR (Accept: application/json) is NOT a navigation → must use E2E.
    expect(
      isE2ePlaintextTunnelExempt({
        method: 'GET',
        path: '/chats/82',
        tunnelId: TUNNEL,
        accept: 'application/json',
      }),
    ).toBe(false);

    // stripSessionCookie keeps the relay access cookie, drops only the session,
    // and collapses to undefined when the session was the only cookie.
    const sid = mintSession(TUNNEL);
    expect(
      stripSessionCookie(`iclaw_tunnel_access=abc; ${SESSION_COOKIE}=${encodeURIComponent(sid)}`),
    ).toBe('iclaw_tunnel_access=abc');
    expect(stripSessionCookie(`${SESSION_COOKIE}=${encodeURIComponent(sid)}`)).toBeUndefined();
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

  it('3b. public app-shell assets are plaintext-exempt; user data is not', () => {
    // CSS/JS/icons are loaded by <link>/<script>/<img> tags after an
    // E2E-delivered page is written — they can't be wrapped, carry no user
    // data, and must be served (else the workspace renders with no styles/JS).
    for (const p of ['/css/style.css', '/css/highlight-github.min.css', '/js/iclaw.js', '/js/vendor/marked.min.js', '/favicon.ico']) {
      expect(
        isE2ePlaintextTunnelExempt({ method: 'GET', path: p, tunnelId: TUNNEL, accept: '*/*' }),
        p,
      ).toBe(true);
    }
    // User-uploaded / media content is NOT a public asset → stays E2E.
    for (const p of ['/uploads/secret.png', '/media/clip.mp4']) {
      expect(
        isE2ePlaintextTunnelExempt({ method: 'GET', path: p, tunnelId: TUNNEL, accept: '*/*' }),
        p,
      ).toBe(false);
    }
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
