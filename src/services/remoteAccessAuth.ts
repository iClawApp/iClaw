/**
 * Per-tunnel password gate.
 *
 * Each Remote Access tunnel has its own passphrase, its own session
 * store, and is enforced independently. Cookies are subdomain-scoped by
 * the browser, so two open tunnels on `a.iclaw.digital` and
 * `b.iclaw.digital` already isolate their cookies at the browser layer;
 * we additionally verify on the server that a session id presented
 * against tunnel X actually belongs to tunnel X (defence in depth
 * against a hand-crafted cross-tunnel cookie replay).
 *
 * Threat model (v0.1):
 * - Relay is honest-forwarder; it sees the passphrase as plain bytes
 *   during the login POST. Full E2E (relay never sees password) lands
 *   later with SPAKE2/OPAQUE.
 * - Direct localhost users (no `x-iclaw-tunneled: 1`) bypass the gate.
 * - In-memory session store; iClaw restart invalidates every session.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/* ------------------------------------------------------------ passphrase -- */

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

/* ---------------------------------------------------------- multi-tunnel -- */

const SESSION_COOKIE = 'iclaw_ra';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const LOGIN_PATH = '/__ra/login';

/** Static assets needed to render the gate page before the user is authenticated. */
const GATE_PUBLIC_ASSETS = new Set([
  '/css/style.css',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
]);

function isGatePublicAsset(path: string): boolean {
  return GATE_PUBLIC_ASSETS.has(path);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** tunnelId → passphrase. Only enabled tunnels are present. */
const passphrases = new Map<string, string>();

interface SessionRecord {
  tunnelId: string;
  expiresAt: number;
}
/** sessionId → { tunnelId, expiresAt }. */
const sessions = new Map<string, SessionRecord>();

let sweepTimer: NodeJS.Timeout | null = null;
function sweepExpired(): void {
  const now = Date.now();
  for (const [id, rec] of sessions) {
    if (rec.expiresAt <= now) sessions.delete(id);
  }
}
function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, 5 * 60 * 1000);
  sweepTimer.unref();
}

function mintSession(tunnelId: string): string {
  const id = randomBytes(32).toString('base64url');
  sessions.set(id, { tunnelId, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function isValidSession(sessionId: string | undefined, tunnelId: string): boolean {
  if (!sessionId) return false;
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  if (rec.tunnelId !== tunnelId) return false;
  if (rec.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ rate-limit -- */

const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { ok: true, retryAfterSec: 0 };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

/* ----------------------------------------------------------- public api -- */

export function enableGate(tunnelId: string, passphrase: string): void {
  passphrases.set(tunnelId, passphrase);
  ensureSweeper();
}

export function disableGate(tunnelId: string): void {
  passphrases.delete(tunnelId);
  // Drop any sessions tied to this tunnel.
  for (const [sid, rec] of sessions) {
    if (rec.tunnelId === tunnelId) sessions.delete(sid);
  }
}

export function disableAllGates(): void {
  passphrases.clear();
  sessions.clear();
  loginAttempts.clear();
}

export function isGateEnabled(tunnelId: string): boolean {
  return passphrases.has(tunnelId);
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

function getTunnelId(req: Request): string | null {
  const h = req.headers[TUNNEL_ID_HEADER];
  if (typeof h === 'string' && h.length > 0) return h;
  return null;
}

function isTunneled(req: Request): boolean {
  return req.headers[TUNNELED_HEADER] === TUNNELED_VALUE;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
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
}): string {
  const safeNext = (opts.next ?? '/').replace(/"/g, '');
  const errorBlock = opts.errorMessage
    ? `<div class="ra-gate-error" role="alert">${escapeHtml(opts.errorMessage)}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Remote Access — iClaw</title>
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
<link rel="stylesheet" href="/css/style.css" />
</head>
<body class="ra-gate-page">
<header class="ra-gate-header">
  <span class="ra-gate-brand">
    <img class="ra-gate-logo" src="/favicon.ico" alt="" width="22" height="22" aria-hidden="true" />
    <span>iClaw</span>
  </span>
</header>

<main class="ra-gate-main">
  <form method="POST" action="${LOGIN_PATH}" autocomplete="off" class="ra-gate-card">
    <h1 class="ra-gate-title">Remote Access</h1>
    <p class="ra-gate-lead">Enter the passphrase shown on the device that started this link</p>

    ${errorBlock}

    <div class="ra-gate-group">
      <label class="ra-gate-row" for="p">
        <span class="ra-gate-row-label">Passphrase</span>
        <input
          id="p"
          class="ra-gate-input"
          name="passphrase"
          type="password"
          autocomplete="current-password"
          required
          autofocus
          spellcheck="false"
          autocapitalize="none"
        />
      </label>
    </div>
    <input type="hidden" name="next" value="${safeNext}" />

    <button class="btn btn--primary ra-gate-submit" type="submit">Continue</button>

    <p class="ra-gate-note">This page is served by your local iClaw — not the relay</p>
  </form>
</main>
</body>
</html>`;
}

/* ----------------------------------------------------------- middleware -- */

export const remoteAccessAuthMiddleware: RequestHandler = (req, res, next) => {
  // Direct localhost / non-tunneled → never interfere.
  if (!isTunneled(req)) return next();

  const tunnelId = getTunnelId(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) {
    // Tunneled request claiming to belong to an unknown tunnel — refuse
    // hard. Should be impossible in normal flow since the loopback
    // injects both headers itself, but be loud if it ever happens.
    res.status(404).type('text/plain').send('tunnel not found');
    return;
  }

  // POST /__ra/login is handled by a separate route; let it through.
  if (req.method === 'POST' && req.path === LOGIN_PATH) return next();

  // Stylesheet + icons for the gate page (static is mounted after this middleware).
  if (req.method === 'GET' && isGatePublicAsset(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies[SESSION_COOKIE], tunnelId)) return next();

  const nextUrl = req.originalUrl && req.originalUrl !== LOGIN_PATH ? req.originalUrl : '/';
  res
    .status(401)
    .type('html')
    .send(renderLoginPage({ next: nextUrl }));
};

export const remoteAccessLoginHandler: RequestHandler = (req, res) => {
  const tunnelId = getTunnelId(req);
  const expected = tunnelId ? passphrases.get(tunnelId) : undefined;
  if (!tunnelId || !expected) {
    res.status(404).type('text/plain').send('not found');
    return;
  }

  // Rate-limit per (ip, tunnelId) so a flood against one tunnel doesn't
  // burn another tunnel's budget on the same IP.
  const ip = (req.ip ?? 'unknown').toString();
  const limitKey = `${ip}|${tunnelId}`;
  const limit = checkRateLimit(limitKey);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res
      .status(429)
      .type('html')
      .send(
        renderLoginPage({
          errorMessage: `Too many attempts. Try again in ${limit.retryAfterSec}s.`,
          next: typeof req.body?.next === 'string' ? req.body.next : '/',
        }),
      );
    return;
  }

  const submitted = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
  if (!constantTimeEquals(submitted, expected)) {
    res
      .status(401)
      .type('html')
      .send(
        renderLoginPage({
          errorMessage: 'Wrong passphrase.',
          next: typeof req.body?.next === 'string' ? req.body.next : '/',
        }),
      );
    return;
  }

  const sessionId = mintSession(tunnelId);
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

  const nextUrl = typeof req.body?.next === 'string' && req.body.next.startsWith('/')
    ? req.body.next
    : '/';
  res.redirect(303, nextUrl);
};

/* ----------------------------------------------------- header sanitation -- */

/**
 * Header names that must NEVER come from a public client through the
 * tunnel — they're meant to be set only by the iClaw loopback forwarder.
 * The relay also strips every `x-iclaw-*`; this is defence in depth on
 * the iClaw side.
 */
export const INTERNAL_TUNNEL_HEADER_NAMES = ['x-iclaw-tunneled', 'x-iclaw-tunnel-id'];

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
export const TUNNEL_ID_HEADER = 'x-iclaw-tunnel-id';

/**
 * Standalone session check for code paths that don't run through Express
 * middleware (notably the WS-upgrade forwarder in `remoteAccess.ts`).
 * Returns true only when the supplied tunnelId has an enabled gate AND
 * the cookie carries a valid session id bound to THAT tunnel.
 */
export function isValidTunnelSession(
  tunnelId: string,
  cookieHeader: string | undefined,
): boolean {
  if (!passphrases.has(tunnelId)) return false;
  const cookies = parseCookies(cookieHeader);
  return isValidSession(cookies[SESSION_COOKIE], tunnelId);
}
