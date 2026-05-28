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
    ? `<div class="err" role="alert">${opts.errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>iClaw — Remote Access</title>
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0e13;
    --surface: #141821;
    --surface-2: #1b202c;
    --border: #232936;
    --border-strong: #2c3343;
    --text: #e6e8eb;
    --muted: #8a94a5;
    --muted-2: #6b7585;
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --accent-ring: rgba(59,130,246,0.20);
    --danger-bg: #3b1216;
    --danger-fg: #f6a8a8;
    --danger-border: #5b1d22;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(1200px 600px at 50% -200px, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%),
      var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── Header ─────────────────────────────────────────────── */
  .header {
    padding: 22px 28px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .header-brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: var(--text);
    text-decoration: none;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
    padding: 4px 6px;
    border-radius: 8px;
    transition: background 0.12s ease;
  }
  .header-brand:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
  .header-logo {
    width: 22px; height: 22px;
    border-radius: 5px;
    display: block;
  }

  /* ── Main card ──────────────────────────────────────────── */
  .main {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 0 24px 24px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 40px 36px 32px;
    max-width: 400px;
    width: 100%;
    box-shadow:
      0 1px 0 color-mix(in srgb, #fff 4%, transparent) inset,
      0 24px 60px rgba(0,0,0,0.45),
      0 2px 6px rgba(0,0,0,0.2);
  }
  .card-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: color-mix(in srgb, var(--accent) 90%, var(--text));
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 16px;
  }
  .card-eyebrow-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .card-title {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .card-desc {
    margin: 0 0 26px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
  }

  .err {
    background: var(--danger-bg);
    color: var(--danger-fg);
    border: 1px solid var(--danger-border);
    padding: 10px 12px;
    border-radius: 9px;
    font-size: 13px;
    line-height: 1.4;
    margin-bottom: 18px;
  }

  .field-label {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin: 0 0 7px;
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  .input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-strong);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 14px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  .input:hover { border-color: color-mix(in srgb, var(--border-strong) 100%, var(--text) 5%); }
  .input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring);
  }

  .submit {
    margin-top: 22px;
    width: 100%;
    padding: 12px 16px;
    border-radius: 10px;
    border: 0;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    letter-spacing: -0.005em;
    cursor: pointer;
    transition: background 0.12s ease, transform 0.08s ease;
  }
  .submit:hover { background: var(--accent-hover); }
  .submit:active { transform: scale(0.985); }
  .submit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .card-foot {
    margin-top: 20px;
    padding-top: 18px;
    border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    color: var(--muted-2);
    font-size: 11.5px;
    line-height: 1.55;
    text-align: center;
  }

  /* ── Footer ─────────────────────────────────────────────── */
  .footer {
    text-align: center;
    padding: 22px 24px 28px;
    color: var(--muted-2);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .footer a {
    color: var(--muted);
    text-decoration: none;
    transition: color 0.12s ease;
  }
  .footer a:hover { color: var(--text); }

  @media (max-width: 480px) {
    .header { padding: 18px 20px; }
    .card { padding: 32px 24px 24px; border-radius: 14px; }
    .card-title { font-size: 20px; }
  }
</style>
</head>
<body>
<header class="header">
  <a class="header-brand" href="https://iclaw.digital" target="_blank" rel="noopener noreferrer">
    <img class="header-logo" src="/favicon.ico" alt="" aria-hidden="true" />
    <span>iClaw</span>
  </a>
</header>

<main class="main">
  <form method="POST" action="${LOGIN_PATH}" autocomplete="off" class="card">
    <span class="card-eyebrow">
      <span class="card-eyebrow-dot" aria-hidden="true"></span>
      Remote Access
    </span>
    <h1 class="card-title">Enter the passphrase</h1>
    <p class="card-desc">
      The passphrase is displayed on the host machine that started this tunnel.
    </p>

    ${errorBlock}

    <label class="field-label" for="p">Passphrase</label>
    <input id="p" class="input" name="passphrase" type="password"
           autocomplete="current-password" required autofocus
           spellcheck="false" autocapitalize="none" />
    <input type="hidden" name="next" value="${safeNext}" />

    <button class="submit" type="submit">Continue</button>

    <div class="card-foot">
      This page is served by your local iClaw — not the relay.
    </div>
  </form>
</main>

<footer class="footer">
  Powered by
  <a href="https://iclaw.digital" target="_blank" rel="noopener noreferrer">iclaw.digital</a>
</footer>
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
