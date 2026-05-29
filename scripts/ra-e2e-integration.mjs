#!/usr/bin/env node
/**
 * Remote Access E2E integration test (alpha).
 *
 * Spins up a REAL relay + REAL iClaw, creates a tunnel, then drives the full
 * visitor flow as a Node "browser":
 *
 *   access gate  →  OPAQUE passphrase login  →  encrypted /__ra/e2e/http  →
 *   inner authenticated GET /
 *
 * It answers the questions a unit test can't:
 *   A. Does the inner authenticated GET / actually return the workspace (200)
 *      or does it bounce off the gate (401)?  (the H1 navigation question)
 *   B. Does the relay only ever see ciphertext on /__ra/e2e/http?  (RELAY_CAPTURE_FILE)
 *   C. Does the relay see the iclaw_ra session cookie?              (H1 leak)
 *   D. C1: do two concurrent streams produce distinct ciphertext?
 *   E. C2: does regenerate-access invalidate the old ?access= link?
 *
 * Faithful browser behaviour: HttpOnly cookies (iclaw_ra, the relay access
 * cookie) ride the OUTER request automatically but are NOT visible to the
 * inner request (which only carries `document.cookie`). That asymmetry is the
 * whole point — it is what would break navigation if inner requests relied on
 * the session cookie.
 *
 * Run:  node scripts/ra-e2e-integration.mjs
 * Exit: 0 = all assertions held, 1 = a hard assertion failed.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as opaque from '@serenity-kit/opaque';

const ICLAW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_ROOT = path.resolve(ICLAW_ROOT, '..', 'iclaw-relay');

const crypto = await import(
  new URL('../dist/services/remoteAccessE2eCrypto.js', import.meta.url).href
);
const { scanRelayCaptureLines, looksLikeE2eWireEnvelope } = await import(
  new URL('../dist/services/remoteAccessCaptureScan.js', import.meta.url).href
);
const { decodeOpaqueSessionKey } = await import(
  new URL('../dist/services/remoteAccessE2eSession.js', import.meta.url).href
);

/* ------------------------------------------------------------- utilities -- */

const log = (...a) => console.log('[itest]', ...a);
let FAILURES = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    FAILURES += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal cookie jar that models HttpOnly visibility. */
function makeJar() {
  const jar = new Map(); // name -> { value, httpOnly }
  return {
    ingest(setCookieHeaders) {
      if (!setCookieHeaders) return;
      const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      for (const sc of arr) {
        const parts = sc.split(';');
        const [nv, ...attrs] = parts;
        const eq = nv.indexOf('=');
        if (eq < 0) continue;
        const name = nv.slice(0, eq).trim();
        const value = nv.slice(eq + 1).trim();
        const httpOnly = attrs.some((a) => a.trim().toLowerCase() === 'httponly');
        if (value === '' ) {
          jar.delete(name);
          continue;
        }
        jar.set(name, { value, httpOnly });
      }
    },
    /** What the browser sends automatically on same-origin requests. */
    outerCookieHeader() {
      return [...jar.entries()].map(([n, c]) => `${n}=${c.value}`).join('; ');
    },
    /** What document.cookie exposes (HttpOnly excluded). */
    documentCookie() {
      return [...jar.entries()]
        .filter(([, c]) => !c.httpOnly)
        .map(([n, c]) => `${n}=${c.value}`)
        .join('; ');
    },
    names() {
      return [...jar.keys()];
    },
  };
}

/**
 * Raw HTTP request straight to 127.0.0.1:<port> with an explicit Host header,
 * so we never depend on DNS for the *.lvh.me wildcard.
 */
function request({ port, host, method = 'GET', path: reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          host,
          ...headers,
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForLine(child, re, label, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (re.test(buf)) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}\n--- output so far ---\n${buf}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

/* ----------------------------------------------------------------- main -- */

const children = [];
function spawnServer(cwd, env, tag) {
  const child = spawn('node', ['dist/index.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const prefix = (line) =>
    line
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => `    [${tag}] ${l}`)
      .join('\n');
  if (process.env.ITEST_VERBOSE) {
    child.stdout.on('data', (d) => console.log(prefix(d)));
    child.stderr.on('data', (d) => console.log(prefix(d)));
  }
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  for (const [root, name] of [
    [ICLAW_ROOT, 'iClaw'],
    [RELAY_ROOT, 'iclaw-relay'],
  ]) {
    if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
      throw new Error(
        `${name} is not built — run \`npm run build\` in ${root} first (the integration test spawns the compiled servers).`,
      );
    }
  }

  await opaque.ready;

  const relayPort = await freePort();
  const iclawPort = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclaw-itest-'));
  const captureFile = path.join(tmp, 'relay-capture.jsonl');
  const dbPath = path.join(tmp, 'iclaw.db');
  const opaqueSetup = opaque.server.createSetup();
  const BASE_DOMAIN = 'lvh.me';

  log(`relay :${relayPort}  iclaw :${iclawPort}`);
  log(`tmp ${tmp}`);

  /* 1. relay */
  const relay = spawnServer(
    RELAY_ROOT,
    {
      NODE_ENV: 'test',
      PORT: String(relayPort),
      HOST: '127.0.0.1',
      BASE_DOMAIN,
      PUBLIC_SCHEME: 'http',
      PUBLIC_PORT: String(relayPort),
      ALLOWED_ORIGINS: '*',
      RELAY_CAPTURE_FILE: captureFile,
      LOG_ACCESS: 'false',
    },
    'relay',
  );
  await waitForLine(relay, /\[iclaw-relay\] listening/, 'relay listening');
  log('relay up');

  /* 2. iClaw (connects out to relay) */
  const iclaw = spawnServer(
    ICLAW_ROOT,
    {
      PORT: String(iclawPort),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      ICLAW_RELAY_URL: `ws://127.0.0.1:${relayPort}/tunnel`,
      OPAQUE_SERVER_SETUP: opaqueSetup,
      ICLAW_OPEN_BROWSER: '0',
    },
    'iclaw',
  );
  await waitForLine(iclaw, /iClaw listening on/, 'iclaw listening');
  log('iclaw up (dials relay lazily once a tunnel exists)');

  /* 3. create tunnel — this triggers the outbound WS to the relay */
  const createRes = await request({
    port: iclawPort,
    host: `127.0.0.1:${iclawPort}`,
    method: 'POST',
    path: '/api/remote-access/tunnels',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ durationMs: 30 * 60_000, label: 'itest' }),
  });
  if (createRes.status !== 201) {
    throw new Error(`create tunnel failed: ${createRes.status} ${createRes.body}`);
  }
  const tunnel = JSON.parse(createRes.body);
  const tunnelId = tunnel.id;
  const passphrase = tunnel.passphrase;

  // url is populated once the relay replies with tunnel-registered.
  let url = tunnel.url;
  for (let i = 0; i < 40 && !url; i++) {
    await sleep(150);
    const listRes = await request({
      port: iclawPort,
      host: `127.0.0.1:${iclawPort}`,
      path: '/api/remote-access/tunnels',
      headers: { accept: 'application/json' },
    });
    const list = JSON.parse(listRes.body);
    url = list.tunnels.find((t) => t.id === tunnelId)?.url ?? null;
  }
  if (!url) throw new Error('tunnel URL never became available');

  const parsed = new URL(url);
  const subHost = parsed.host; // e.g. silver-fox.lvh.me:<port>
  const accessToken = parsed.searchParams.get('access');
  log(`tunnel ${tunnelId} → ${subHost} (access ${accessToken ? 'present' : 'MISSING'})`);

  const jar = makeJar();
  const via = (opts) =>
    request({ port: relayPort, host: subHost, ...opts }).then((res) => {
      jar.ingest(res.headers['set-cookie']);
      return res;
    });

  /* 4. access gate */
  const gate = await via({
    path: `/?access=${accessToken}`,
    headers: { accept: 'text/html' },
  });
  check('access gate redirects with ?access=', gate.status === 302, `status ${gate.status}`);
  check('relay sets access cookie', jar.names().some((n) => n.includes('access')), jar.names().join(','));

  /* 5. gate page (now authorised by relay) */
  const gatePage = await via({
    path: '/',
    headers: { accept: 'text/html', cookie: jar.outerCookieHeader() },
  });
  // Pre-login GET / is the passphrase gate: the middleware answers 401 with the
  // login HTML (that 401 *is* the "please log in" signal, not an error).
  check('gate page is served (401 + login form)', gatePage.status === 401, `status ${gatePage.status}`);
  check('gate page is the iClaw passphrase gate', /iclaw-ra-e2e/.test(gatePage.body));
  const metaTunnelId = /name="iclaw-ra-tunnel-id" content="([^"]*)"/.exec(gatePage.body)?.[1];
  check('gate exposes tunnelId meta', metaTunnelId === tunnelId, `${metaTunnelId} vs ${tunnelId}`);

  /* 6. OPAQUE login */
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: passphrase });
  const startRes = await via({
    method: 'POST',
    path: '/__ra/opaque/login/start',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: jar.outerCookieHeader(),
    },
    body: JSON.stringify({ startLoginRequest }),
  });
  check('OPAQUE start ok', startRes.status === 200, `status ${startRes.status} ${startRes.body}`);
  const startData = JSON.parse(startRes.body);
  const clientResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: startData.loginResponse,
    password: passphrase,
  });
  check('OPAQUE client finishes (right passphrase)', !!clientResult);

  const finishRes = await via({
    method: 'POST',
    path: '/__ra/opaque/login/finish',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: jar.outerCookieHeader(),
    },
    body: JSON.stringify({
      loginStateId: startData.loginStateId,
      finishLoginRequest: clientResult.finishLoginRequest,
      next: '/',
    }),
  });
  check('OPAQUE finish ok', finishRes.status === 200, `status ${finishRes.status} ${finishRes.body}`);
  const finishData = JSON.parse(finishRes.body);
  const transportHandle = finishData.transportHandle;
  check('finish returns transportHandle', typeof transportHandle === 'string' && transportHandle.length > 0);
  // E2E-only design: the browser must NOT be handed the iclaw_ra session cookie
  // (if it were, the browser would send it on outer requests and the relay
  // would see it). Inner requests authenticate via the E2E transport session.
  check('login does NOT hand iclaw_ra to the browser', !jar.names().includes('iclaw_ra'), jar.names().join(','));

  /* 7. derive E2E keys exactly like the browser */
  const relayBinding = crypto.relayAccessBindingFromAccessToken(accessToken);
  const keys = crypto.deriveE2eSessionKeys(
    decodeOpaqueSessionKey(clientResult.sessionKey),
    tunnelId,
    relayBinding,
  );
  const s2cLedger = new crypto.E2eCounterLedger();

  // Build an encrypted inner request and POST it through /__ra/e2e/http.
  async function e2eRequest(innerPath, { method = 'GET', streamId } = {}) {
    const sid = streamId ?? Buffer.from(globalThisRandom(8)).toString('hex');
    const ctr = 0; // fresh stream
    const inner = {
      id: sid,
      method,
      path: innerPath,
      headers: {
        accept: 'text/html,application/json',
        // The browser only has document.cookie here — HttpOnly cookies excluded.
        ...(jar.documentCookie() ? { cookie: jar.documentCookie() } : {}),
      },
      bodyB64: '',
    };
    const ciphertext = crypto.encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: sid,
      ctr,
      kind: 'http-req',
      inner: new TextEncoder().encode(JSON.stringify(inner)),
      relayBinding,
    });
    const wire = crypto.encodeWireEnvelope({
      sid: transportHandle,
      ctr,
      kind: 'http-req',
      streamId: sid,
      ciphertext,
    });
    const outer = await via({
      method: 'POST',
      path: '/__ra/e2e/http',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: jar.outerCookieHeader(),
      },
      body: wire,
    });
    if (outer.status !== 200) {
      return { outerStatus: outer.status, innerStatus: null, body: outer.body, wireReq: wire, wireRes: null };
    }
    const decoded = crypto.decodeWireEnvelope(outer.body);
    const plain = crypto.decryptE2eRecord(
      keys,
      's2c',
      {
        tunnelId,
        streamId: decoded.streamId,
        ctr: decoded.ctr,
        kind: decoded.kind,
        ciphertext: decoded.ciphertext,
        relayBinding,
      },
      s2cLedger,
    );
    if (!plain) return { outerStatus: 200, innerStatus: null, body: '<decrypt failed>', wireReq: wire, wireRes: outer.body };
    const innerRes = JSON.parse(new TextDecoder().decode(plain.inner));
    const innerBody = innerRes.bodyB64
      ? Buffer.from(innerRes.bodyB64, 'base64').toString('utf8')
      : '';
    return { outerStatus: 200, innerStatus: innerRes.status, body: innerBody, wireReq: wire, wireRes: outer.body };
  }

  /* 8. THE question: authenticated inner GET / */
  const nav = await e2eRequest('/', { streamId: 'stream-nav-1' });
  log(`inner GET / → outer ${nav.outerStatus}, inner ${nav.innerStatus}`);
  // The gate login page is uniquely identifiable by its passphrase <form>.
  // The workspace page may legitimately carry the iclaw-ra-e2e meta (the
  // transport shim needs it), so we must NOT key the bounce check on that.
  const isGateBounce = nav.innerStatus === 401 || /id="ra-gate-form"/.test(nav.body);
  const isWorkspace = nav.innerStatus === 200 && !isGateBounce;
  if (isWorkspace) {
    check('NAV: inner GET / returns the workspace (200)', true);
  } else if (isGateBounce) {
    check(
      'NAV: inner GET / returns the workspace (200)',
      false,
      `got inner ${nav.innerStatus} — bounced to the gate (H1 navigation bug)`,
    );
  } else {
    check('NAV: inner GET / returns the workspace (200)', false, `unexpected inner ${nav.innerStatus}`);
  }

  /* 9. C1: two concurrent streams, same ctr=0, distinct ciphertext */
  const a = await e2eRequest('/', { streamId: 'stream-c1-A' });
  const b = await e2eRequest('/', { streamId: 'stream-c1-B' });
  const ctA = crypto.decodeWireEnvelope(a.wireReq)?.ciphertext;
  const ctB = crypto.decodeWireEnvelope(b.wireReq)?.ciphertext;
  check(
    'C1: distinct streams produce distinct ciphertext at ctr=0',
    ctA && ctB && Buffer.compare(Buffer.from(ctA), Buffer.from(ctB)) !== 0,
  );

  /* 10. capture-file scan (relay sees only ciphertext on /__ra/e2e/http) */
  await sleep(200); // let the relay flush the last append
  const capLines = fs.existsSync(captureFile)
    ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean)
    : [];
  const records = capLines.map((l) => JSON.parse(l));
  const e2eRecords = records.filter((r) => r.outer.path === '/__ra/e2e/http');
  check('relay captured E2E http frames', e2eRecords.length >= 1, `count ${e2eRecords.length}`);

  let allCipher = true;
  for (const r of e2eRecords) {
    const reqBody = Buffer.from(r.reqBodyB64, 'base64').toString('utf8');
    const resBody = r.resBodyB64 ? Buffer.from(r.resBodyB64, 'base64').toString('utf8') : '';
    if (!looksLikeE2eWireEnvelope(reqBody)) allCipher = false;
    if (resBody && !looksLikeE2eWireEnvelope(resBody)) allCipher = false;
  }
  check('relay E2E request/response bodies are wire envelopes only', allCipher);

  const e2eBodyScan = scanRelayCaptureLines(
    e2eRecords.flatMap((r) => [
      Buffer.from(r.reqBodyB64, 'base64').toString('utf8'),
      r.resBodyB64 ? Buffer.from(r.resBodyB64, 'base64').toString('utf8') : '',
    ]),
  );
  check(
    'relay E2E payload bodies contain no plaintext leaks (passphrase/html/chat/cookie)',
    e2eBodyScan.ok,
    e2eBodyScan.hits.map((h) => h.rule).join(','),
  );

  /* 11. H1 leak: the relay must NOT see iclaw_ra anywhere in outer metadata. */
  const sawIclawRaOnRelay = records.some((r) =>
    /iclaw_ra=/.test(String(r.outer.headers?.cookie ?? '')),
  );
  check(
    'H1: relay never sees the iclaw_ra session cookie',
    !sawIclawRaOnRelay,
    'iclaw_ra present in outer request cookies forwarded by the relay',
  );

  /* 11b. M1: a second visitor activating the SAME link must not evict the first. */
  const jar2 = makeJar();
  const v2Activate = await request({
    port: relayPort,
    host: subHost,
    path: `/?access=${accessToken}`,
    headers: { accept: 'text/html' },
  }).then((res) => {
    jar2.ingest(res.headers['set-cookie']);
    return res;
  });
  check('M1: second visitor activates the link (302)', v2Activate.status === 302, `status ${v2Activate.status}`);
  // 401 = relay access gate ALLOWED the request (it reached iClaw's login gate);
  // 403 = relay access gate DENIED it. Both visitors must see 401, not 403.
  const v2Reaches = await request({
    port: relayPort,
    host: subHost,
    path: '/',
    headers: { accept: 'text/html', cookie: jar2.outerCookieHeader() },
  });
  check('M1: second visitor passes the relay gate', v2Reaches.status === 401, `status ${v2Reaches.status}`);
  const v1StillReaches = await request({
    port: relayPort,
    host: subHost,
    path: '/',
    headers: { accept: 'text/html', cookie: jar.outerCookieHeader() },
  });
  check(
    'M1: first visitor still passes the relay gate (not evicted)',
    v1StillReaches.status === 401,
    `status ${v1StillReaches.status} (403 = evicted)`,
  );

  /* 11c. Returning-visitor: a plaintext top-level GET / carrying a stray
     iclaw_ra session cookie must serve the gate (re-login), never the
     "E2E transport required" JSON dead-end and never the workspace. */
  const stray = await request({
    port: relayPort,
    host: subHost,
    path: '/',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      cookie: `${jar.outerCookieHeader()}; iclaw_ra=stale-bogus-session-value-xxxxxxxxxxxxxxxxxxxxx`,
    },
  });
  check(
    'returning-visitor: stray iclaw_ra on GET / → gate, not JSON dead-end',
    stray.status === 401 && /id="ra-gate-form"/.test(stray.body) && !/E2E transport required/.test(stray.body),
    `status ${stray.status}, json=${/E2E transport required/.test(stray.body)}`,
  );

  /* 11d. Deep-link navigation (clicking a chat / reload of /chats/:id) is a
     top-level HTML navigation → must serve the gate bootstrap, not the JSON
     dead-end and not the workspace. */
  const deepLink = await request({
    port: relayPort,
    host: subHost,
    path: '/chats/82',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      cookie: jar.outerCookieHeader(),
    },
  });
  check(
    'deep-link nav (/chats/82) → gate bootstrap, not JSON dead-end',
    deepLink.status === 401 && /id="ra-gate-form"/.test(deepLink.body) && !/E2E transport required/.test(deepLink.body),
    `status ${deepLink.status}, json=${/E2E transport required/.test(deepLink.body)}`,
  );

  // A data XHR (Accept: application/json) to a workspace path must still be
  // forced to E2E (NOT served plaintext) — proves we didn't over-open the gate.
  const dataXhr = await request({
    port: relayPort,
    host: subHost,
    path: '/api/chats/82',
    headers: { accept: 'application/json', cookie: jar.outerCookieHeader() },
  });
  check(
    'plaintext data XHR is refused (E2E required), not served',
    /E2E transport required/.test(dataXhr.body) || dataXhr.status === 401,
    `status ${dataXhr.status}`,
  );

  /* 11e. App-shell static asset (loaded by <script>/<link>, can't be E2E-wrapped)
     must be served in the clear — otherwise the workspace renders without CSS/JS
     ("can't see messages"). It's public, carries no user data. */
  const staticAsset = await request({
    port: relayPort,
    host: subHost,
    path: '/js/iclaw.js',
    headers: {
      accept: '*/*',
      'sec-fetch-dest': 'script',
      'sec-fetch-mode': 'no-cors',
      cookie: jar.outerCookieHeader(),
    },
  });
  check(
    'app-shell static asset (/js/iclaw.js) is served, not 426',
    staticAsset.status === 200 && !/E2E transport required/.test(staticAsset.body),
    `status ${staticAsset.status}`,
  );

  // But user-uploaded content (/uploads) must NOT be served plaintext.
  const upload = await request({
    port: relayPort,
    host: subHost,
    path: '/uploads/whatever.bin',
    headers: { accept: '*/*', 'sec-fetch-dest': 'image', cookie: jar.outerCookieHeader() },
  });
  check(
    'user uploads stay E2E-gated (not served plaintext)',
    /E2E transport required/.test(upload.body) || upload.status === 401 || upload.status === 426,
    `status ${upload.status}`,
  );

  /* 12. C2: regenerate access invalidates the old ?access= link */
  const regen = await request({
    port: iclawPort,
    host: `127.0.0.1:${iclawPort}`,
    method: 'POST',
    path: `/api/remote-access/tunnels/${tunnelId}/regenerate-access`,
    headers: { accept: 'application/json' },
  });
  check('regenerate-access ok', regen.status === 200, `status ${regen.status}`);
  const newUrl = JSON.parse(regen.body).url;
  const newAccess = newUrl ? new URL(newUrl).searchParams.get('access') : null;
  check('regenerate returns a different access token', !!newAccess && newAccess !== accessToken);

  // Old access cookie/token must now be rejected by the relay gate.
  const oldLink = await request({
    port: relayPort,
    host: subHost,
    path: `/?access=${accessToken}`,
    headers: { accept: 'text/html' },
  });
  check('C2: old ?access= link is now 403', oldLink.status === 403, `status ${oldLink.status}`);

  const freshJar = makeJar();
  const newLink = await request({
    port: relayPort,
    host: subHost,
    path: `/?access=${newAccess}`,
    headers: { accept: 'text/html' },
  }).then((res) => {
    freshJar.ingest(res.headers['set-cookie']);
    return res;
  });
  check('C2: new ?access= link works (302)', newLink.status === 302, `status ${newLink.status}`);
}

main()
  .then(() => {
    cleanup();
    console.log('');
    if (FAILURES === 0) {
      console.log('[itest] ALL CHECKS PASSED');
      process.exit(0);
    } else {
      console.log(`[itest] ${FAILURES} CHECK(S) FAILED`);
      process.exit(1);
    }
  })
  .catch((err) => {
    cleanup();
    console.error('[itest] ERROR', err);
    process.exit(1);
  });

/* tiny random helper kept local to avoid extra imports */
function globalThisRandom(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}
