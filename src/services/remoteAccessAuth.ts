/**
 * Password gate for tunneled (remote-access) requests.
 *
 * Threat model (v0.1):
 * - Relay is honest-forwarder; it sees TLS-terminated bytes but we never
 *   send the passphrase to it. The login POST is forwarded *through* the
 *   relay as ordinary HTTP body, so the relay does technically see those
 *   bytes — full E2E (relay never sees the password) lands later with
 *   SPAKE2. For now we accept "relay can read the password if malicious"
 *   in exchange for shippable simplicity.
 * - Direct localhost users (127.0.0.1) bypass the gate entirely; only
 *   requests that arrive via the tunnel are challenged.
 * - In-memory session store; iClaw restart invalidates every session.
 *
 * Mechanism:
 * - On enable(), a fresh diceware-style passphrase is generated and shown
 *   in the iClaw process log.
 * - `remoteAccess.ts` injects `x-iclaw-tunneled: 1` on every loopback
 *   request so the middleware can distinguish "came via tunnel" from
 *   "direct localhost".
 * - Without a valid `iclaw_ra` cookie, tunneled requests get a tiny inline
 *   login HTML.
 * - POST /__ra/login validates the passphrase (constant-time compare),
 *   mints a random 256-bit session id, sets the cookie, and redirects to
 *   the page the user originally asked for.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/* ------------------------------------------------------------ passphrase -- */

// ~80 short, unambiguous words. Entropy: 80^4 ≈ 41M ≈ 25 bits, plus a
// 3-digit suffix (~10 bits) → ~35 bits. Brute-force online is infeasible
// once login rate-limiting kicks in.
const WORDS = [
  'amber', 'apple', 'arrow', 'aspen', 'autumn', 'banjo', 'basil', 'beach',
  'birch', 'blaze', 'bloom', 'bramble', 'breeze', 'brook', 'cabin', 'cedar',
  'cider', 'cliff', 'clover', 'comet', 'copper', 'coral', 'cosmic', 'cozy',
  'crimson', 'daisy', 'dawn', 'delta', 'dune', 'ember', 'falcon', 'fern',
  'fjord', 'forest', 'frost', 'galaxy', 'garnet', 'glade', 'harbor', 'hazel',
  'heron', 'honey', 'ivory', 'jade', 'kelp', 'lantern', 'lily', 'lotus',
  'maple', 'meadow', 'misty', 'moss', 'mountain', 'nimbus', 'oak', 'ocean',
  'olive', 'orchard', 'otter', 'pearl', 'pebble', 'pine', 'plum', 'quartz',
  'rapid', 'raven', 'reef', 'river', 'rose', 'sage', 'silver', 'sparrow',
  'spruce', 'stone', 'sunny', 'thicket', 'tide', 'topaz', 'velvet', 'willow',
];

const PHRASE_WORD_COUNT = 4;
const PHRASE_DIGIT_COUNT = 3;

export function generatePassphrase(): string {
  const words: string[] = [];
  for (let i = 0; i < PHRASE_WORD_COUNT; i++) {
    words.push(WORDS[randomInt(0, WORDS.length)] as string);
  }
  let digits = '';
  for (let i = 0; i < PHRASE_DIGIT_COUNT; i++) {
    digits += randomInt(0, 10).toString();
  }
  return `${words.join('-')}-${digits}`;
}

/* --------------------------------------------------------- session store -- */

const SESSION_COOKIE = 'iclaw_ra';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const LOGIN_PATH = '/__ra/login';

interface SessionRecord {
  expiresAt: number;
}

let currentPassphrase: string | null = null;
const sessions = new Map<string, SessionRecord>();
let sweepTimer: NodeJS.Timeout | null = null;

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, rec] of sessions) {
    if (rec.expiresAt <= now) sessions.delete(id);
  }
}

function startSweeperIfNeeded(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, 5 * 60 * 1000);
  sweepTimer.unref();
}

function mintSession(): string {
  const id = randomBytes(32).toString('base64url');
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function isValidSession(id: string | undefined): boolean {
  if (!id) return false;
  const rec = sessions.get(id);
  if (!rec) return false;
  if (rec.expiresAt <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ rate-limit -- */

// Tiny in-memory IP rate limiter for /__ra/login. Online-only brute force
// against a 35-bit phrase is infeasible at this rate.
const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { ok: true, retryAfterSec: 0 };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

/* ----------------------------------------------------------- public api -- */

export function enableGate(passphrase: string): void {
  currentPassphrase = passphrase;
  sessions.clear();
  startSweeperIfNeeded();
}

export function disableGate(): void {
  currentPassphrase = null;
  sessions.clear();
  loginAttempts.clear();
}

export function isGateEnabled(): boolean {
  return currentPassphrase !== null;
}

/* ------------------------------------------------------- helpers / parsing -- */

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function isTunneled(req: Request): boolean {
  return req.headers['x-iclaw-tunneled'] === '1';
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a compare against a same-length buffer to avoid timing leak
    // on length; result intentionally discarded.
    const padding = Buffer.alloc(ab.length);
    timingSafeEqual(ab, padding);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* ---------------------------------------------------- login page HTML -- */

function renderLoginPage(opts: {
  errorMessage?: string;
  next?: string;
  status: 200 | 401;
}): string {
  const safeNext = (opts.next ?? '/').replace(/"/g, '');
  const errorBlock = opts.errorMessage
    ? `<div class="err">${opts.errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>iClaw — Remote Access</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e1116; color: #e6e8eb; }
  form { background: #161a22; padding: 32px 28px; border-radius: 12px;
         max-width: 360px; width: 92%; box-shadow: 0 8px 32px rgba(0,0,0,.35);
         border: 1px solid #232936; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #95a0b0; font-size: 13px; line-height: 1.4; }
  label { display: block; font-size: 12px; color: #95a0b0; margin: 0 0 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border-radius: 8px;
         border: 1px solid #2a3140; background: #0e1116; color: #e6e8eb;
         font-size: 14px; box-sizing: border-box; }
  input[type=password]:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  button { margin-top: 16px; width: 100%; padding: 10px 14px; border-radius: 8px;
         border: 0; background: #3b82f6; color: #fff; font-weight: 600;
         font-size: 14px; cursor: pointer; }
  button:hover { background: #2563eb; }
  .err { background: #3b1216; color: #f6a8a8; border: 1px solid #5b1d22;
         padding: 8px 10px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
  .foot { margin-top: 16px; color: #6b7585; font-size: 11px; text-align: center; }
</style>
</head>
<body>
<form method="POST" action="${LOGIN_PATH}" autocomplete="off">
  <h1>iClaw Remote Access</h1>
  <p>Enter the passphrase shown on the host machine to continue.</p>
  ${errorBlock}
  <label for="p">Passphrase</label>
  <input id="p" name="passphrase" type="password" autocomplete="current-password" required autofocus />
  <input type="hidden" name="next" value="${safeNext}" />
  <button type="submit">Continue</button>
  <div class="foot">This page is served by your local iClaw, not the relay.</div>
</form>
</body>
</html>`;
}

/* ----------------------------------------------------------- middleware -- */

export const remoteAccessAuthMiddleware: RequestHandler = (req, res, next) => {
  // Gate is off → never interfere.
  if (!currentPassphrase) return next();

  // Direct localhost / non-tunneled → never interfere.
  if (!isTunneled(req)) return next();

  // POST /__ra/login is handled by a separate route below; let it through.
  if (req.method === 'POST' && req.path === LOGIN_PATH) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies[SESSION_COOKIE])) return next();

  // No / invalid session — serve the login page in place of whatever was requested.
  const nextUrl = req.originalUrl && req.originalUrl !== LOGIN_PATH ? req.originalUrl : '/';
  res
    .status(401)
    .type('html')
    .send(renderLoginPage({ next: nextUrl, status: 401 }));
};

/**
 * POST /__ra/login handler. Mounted by app.ts. Reads the urlencoded form
 * body (express.urlencoded is already on the iClaw app), validates the
 * passphrase, mints a session and redirects.
 */
export const remoteAccessLoginHandler: RequestHandler = (req, res) => {
  if (!currentPassphrase) {
    // Gate isn't enabled — pretend it doesn't exist.
    res.status(404).type('text/plain').send('not found');
    return;
  }

  const ip = (req.ip ?? 'unknown').toString();
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res
      .status(429)
      .type('html')
      .send(
        renderLoginPage({
          errorMessage: `Too many attempts. Try again in ${limit.retryAfterSec}s.`,
          next: typeof req.body?.next === 'string' ? req.body.next : '/',
          status: 401,
        }),
      );
    return;
  }

  const submitted = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
  if (!constantTimeEquals(submitted, currentPassphrase)) {
    res
      .status(401)
      .type('html')
      .send(
        renderLoginPage({
          errorMessage: 'Wrong passphrase.',
          next: typeof req.body?.next === 'string' ? req.body.next : '/',
          status: 401,
        }),
      );
    return;
  }

  const sessionId = mintSession();
  const isHttps = (req.headers['x-forwarded-proto'] ?? '').toString().toLowerCase() === 'https';
  const cookieParts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/')
    ? req.body.next
    : '/';
  res.redirect(303, next);
};

/* ----------------------------------------------------- header sanitation -- */

/**
 * Header names that must NEVER come from a public client through the
 * tunnel — they're meant to be set only by our own loopback. Stripped on
 * the iClaw side as well as the relay side, for defence in depth.
 */
export const INTERNAL_TUNNEL_HEADER_NAMES = ['x-iclaw-tunneled'];

export function stripInternalHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (INTERNAL_TUNNEL_HEADER_NAMES.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export const TUNNELED_HEADER = 'x-iclaw-tunneled';
export const TUNNELED_VALUE = '1';

/**
 * Standalone session check for code paths that don't run through Express
 * middleware (notably the WS-upgrade forwarder in `remoteAccess.ts`).
 * Returns true only when the gate is enabled AND the supplied cookie
 * header contains a valid session id. When the gate is disabled this
 * returns false: tunneled traffic shouldn't exist without an active gate,
 * and refusing here is the safer default.
 */
export function isValidTunnelSession(cookieHeader: string | undefined): boolean {
  if (!currentPassphrase) return false;
  const cookies = parseCookies(cookieHeader);
  return isValidSession(cookies[SESSION_COOKIE]);
}

/* ---------------------------------------------------- test-only helpers -- */

export const __internal = {
  loginPath: LOGIN_PATH,
  cookieName: SESSION_COOKIE,
  renderLoginPage,
  isValidSession,
  parseCookies,
};
