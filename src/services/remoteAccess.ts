/**
 * Remote Access runtime — single multiplexed WS.
 *
 * One persistent WebSocket lives between this iClaw process and the
 * relay. All Remote Access tunnels are multiplexed inside it: each
 * `register-tunnel` message asks the relay to mint a subdomain for a
 * given tunnelId, and every subsequent frame (req / ws-* / etc.) carries
 * that tunnelId so we can route to the right local tunnel.
 *
 * Why one WS instead of one-per-tunnel:
 *  - 4 tunnels no longer mean 4 reconnect storms when the relay restarts.
 *  - Rate-limiting on the relay can target "new tunnel creations" instead
 *    of "new connections", so reconnects no longer count.
 *  - It's how every real tunnel service (ngrok, Cloudflare Tunnel,
 *    Tailscale) does it.
 *
 * Activation paths:
 *  - UI: POST /api/remote-access/tunnels → createTunnel().
 *  - On iClaw startup: resumeAll() rehydrates every persisted tunnel
 *    whose `expiresAt` is still in the future, and re-registers them
 *    with the relay as soon as the shared WS comes up.
 *
 * Subdomains are stable across short relay disconnects: the relay
 * reserves tunnelId → subdomain for ~10 min and restores the same URL
 * on re-register. tunnelId and passphrase always live in iClaw SQLite.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

import {
  enableGate,
  disableGate,
  disableAllGates,
  generatePassphrase,
  stripInternalHeaders,
  stripSessionCookie,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
  TUNNEL_ID_HEADER,
} from './remoteAccessAuth';
import {
  generateTunnelId,
  generateOwnerSecret,
  remoteAccessState,
  ensureAccessToken,
  ensureOwnerSecret,
  type PersistedTunnel,
} from './remoteAccessState';
import {
  closeE2eWsBridge,
  E2E_HTTP_PATH,
  E2E_WS_PATH,
  handleE2eHttpFrame,
  handleE2eWsData,
  handleE2eWsOpen,
  isE2ePlaintextTunnelExempt,
  type E2eWsBridge,
} from './remoteAccessE2eTransport';
import {
  ensureOpaqueServerSetup,
  syncOpaqueRegistrationsWithServerSetup,
} from './remoteAccessOpaque';
import {
  ACCESS_QUERY_PARAM,
  buildPublicAccessUrl,
  hashAccessToken,
  generateAccessToken,
} from './remoteAccessToken';

/* ---------------------------------------------------------------- frames -- */

interface RegisterTunnelFrame {
  t: 'register-tunnel';
  tunnelId: string;
  label?: string | null;
  tokenHash: string;
  /** Ownership secret (plaintext over the trusted iClaw→relay WS). Relay stores SHA-256 only. */
  ownerProof?: string;
}
interface UnregisterTunnelFrame {
  t: 'unregister-tunnel';
  tunnelId: string;
}
interface TunnelRegisteredFrame {
  t: 'tunnel-registered';
  tunnelId: string;
  subdomain: string;
  baseDomain: string;
  publicUrl: string;
}
interface TunnelRejectedFrame {
  t: 'tunnel-rejected';
  tunnelId: string;
  reason: string;
  retryAfterSec?: number;
}
interface ReqFrame {
  t: 'req';
  tunnelId: string;
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
interface ResFrame {
  t: 'res';
  tunnelId: string;
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface ErrFrame {
  t: 'err';
  tunnelId: string;
  id?: string;
  message: string;
}
interface WsOpenFrame {
  t: 'ws-open';
  tunnelId: string;
  id: string;
  path: string;
  headers: Record<string, string>;
}
interface WsDataFrame {
  t: 'ws-data';
  tunnelId: string;
  id: string;
  binary: boolean;
  data: string;
}
interface WsCloseFrame {
  t: 'ws-close';
  tunnelId: string;
  id: string;
  code?: number;
  reason?: string;
}

type Frame =
  | RegisterTunnelFrame
  | UnregisterTunnelFrame
  | TunnelRegisteredFrame
  | TunnelRejectedFrame
  | ReqFrame
  | ResFrame
  | ErrFrame
  | WsOpenFrame
  | WsDataFrame
  | WsCloseFrame
  | { t: 'ping' }
  | { t: 'pong' };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
function stripHopByHop(
  headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/* --------------------------------------------------------------- limits -- */

export const ALLOWED_DURATIONS_MS: readonly number[] = Object.freeze([
  30 * 60_000,
  12 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
]);

/* ------------------------------------------------------------- runtime -- */

interface StreamState {
  ws: WebSocket;
  pending: { data: string; binary: boolean }[];
}

interface RuntimeTunnel {
  id: string;                  // tunnelId, stable across reconnects
  label: string | null;
  passphrase: string;
  /** Relay gate secret — never sent to relay, only SHA-256 hash. */
  accessToken: string;
  /** Tunnel ownership secret — sent to relay on register; relay stores SHA-256 only. */
  ownerSecret: string;
  durationMs: number;
  startedAt: number;
  expiresAt: number;
  createdAt: number;
  /** Full URL with ?access= when tunnel-registered arrives. */
  currentUrl: string | null;
  expiryTimer: NodeJS.Timeout | null;
  /** Loopback WS streams (per public ws-open). */
  streams: Map<string, StreamState>;
  /** E2E encrypted WS bridges (path /__ra/e2e/ws). */
  e2eWsBridges: Map<string, E2eWsBridge>;
}

let bound: { relayUrl: string; localHost: string; localPort: number } | null = null;

/** The shared iClaw → relay WebSocket. Null when not connected. */
let ws: WebSocket | null = null;
let stopped = false;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

/** WS-protocol keep-alive — Cloudflare closes idle WS after ~100s. */
const KEEP_ALIVE_MS = 30_000;
let wsPingTimer: NodeJS.Timeout | null = null;
let wsAlive = true;

function clearWsKeepAlive(): void {
  if (wsPingTimer) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  wsAlive = true;
}

function startWsKeepAlive(socket: WebSocket): void {
  clearWsKeepAlive();
  wsAlive = true;
  socket.on('pong', () => {
    wsAlive = true;
  });
  wsPingTimer = setInterval(() => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
      clearWsKeepAlive();
      return;
    }
    if (!wsAlive) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      return;
    }
    wsAlive = false;
    try {
      socket.ping();
    } catch {
      // ignore
    }
  }, KEEP_ALIVE_MS);
  wsPingTimer.unref();
}

/** Active tunnels keyed by tunnelId. URL is null when relay not yet replied. */
const tunnels = new Map<string, RuntimeTunnel>();

export interface TunnelStatus {
  id: string;
  label: string | null;
  url: string | null;
  passphrase: string;
  startedAt: number;
  durationMs: number;
  expiresAt: number;
}

function toStatus(rt: RuntimeTunnel): TunnelStatus {
  return {
    id: rt.id,
    label: rt.label,
    url: rt.currentUrl,
    passphrase: rt.passphrase,
    startedAt: rt.startedAt,
    durationMs: rt.durationMs,
    expiresAt: rt.expiresAt,
  };
}

function makeRuntime(p: PersistedTunnel): RuntimeTunnel {
  const withToken = ensureOwnerSecret(ensureAccessToken(p));
  return {
    id: withToken.id,
    label: withToken.label,
    passphrase: withToken.passphrase,
    accessToken: withToken.accessToken,
    ownerSecret: withToken.ownerSecret,
    durationMs: withToken.durationMs,
    startedAt: withToken.startedAt,
    expiresAt: withToken.expiresAt,
    createdAt: withToken.createdAt,
    currentUrl: null,
    expiryTimer: null,
    streams: new Map(),
    e2eWsBridges: new Map(),
  };
}

/** setTimeout's 32-bit ceiling (~24.8 days); longer delays overflow and fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

let quietLogs = false;
/**
 * Silence routine remote-access info logs (used while the headless onboarding
 * owns the terminal, so they don't clutter the polished screens). Warnings and
 * errors still surface.
 */
export function setRemoteAccessQuiet(quiet: boolean): void {
  quietLogs = quiet;
}
function rlog(msg: string): void {
  if (!quietLogs) process.stdout.write(msg + '\n');
}

function scheduleExpiry(rt: RuntimeTunnel): void {
  if (rt.expiryTimer) {
    clearTimeout(rt.expiryTimer);
    rt.expiryTimer = null;
  }
  const delta = rt.expiresAt - Date.now();
  if (delta <= 0) {
    setTimeout(() => removeTunnelLocal(rt.id), 0);
    return;
  }
  // A 30-day link (~2.59e9 ms) exceeds setTimeout's 2^31-1 limit, which would
  // otherwise overflow and fire immediately. Clamp and re-arm the remainder.
  if (delta > MAX_TIMER_MS) {
    rt.expiryTimer = setTimeout(() => {
      rt.expiryTimer = null;
      scheduleExpiry(rt);
    }, MAX_TIMER_MS);
    rt.expiryTimer.unref();
    return;
  }
  rt.expiryTimer = setTimeout(() => {
    rt.expiryTimer = null;
    rlog(`[remote-access:${rt.id}] duration elapsed`);
    deleteTunnelImpl(rt.id);
  }, delta);
  rt.expiryTimer.unref();
}

function safeSend(frame: Frame): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function registerOverWire(rt: RuntimeTunnel): void {
  safeSend({
    t: 'register-tunnel',
    tunnelId: rt.id,
    label: rt.label,
    tokenHash: hashAccessToken(rt.accessToken),
    ownerProof: rt.ownerSecret,
  });
}

function unregisterOverWire(tunnelId: string): void {
  safeSend({ t: 'unregister-tunnel', tunnelId });
}

/* -------------------------------------------------------- frame handlers -- */

function handleTunnelRegistered(f: TunnelRegisteredFrame): void {
  const rt = tunnels.get(f.tunnelId);
  if (!rt) return;
  rt.currentUrl = buildPublicAccessUrl(f.publicUrl, rt.accessToken);
  rlog(`[remote-access:${rt.id}] tunnel ready → ${f.publicUrl}`);
}

function handleTunnelRejected(f: TunnelRejectedFrame): void {
  console.warn(
    `[remote-access:${f.tunnelId}] rejected by relay: ${f.reason}` +
      (f.retryAfterSec ? ` (retry in ${f.retryAfterSec}s)` : ''),
  );
}

function sendE2eRequiredRes(tunnelId: string, reqId: string): void {
  const body = JSON.stringify({
    error: 'E2E transport required — use encrypted /__ra/e2e/http',
  });
  const out: ResFrame = {
    t: 'res',
    tunnelId,
    id: reqId,
    status: 426,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(body, 'utf8').toString('base64'),
  };
  safeSend(out);
}

function handleReq(socket: WebSocket, frame: ReqFrame): void {
  void (async () => {
    if (!bound) {
      sendErr(socket, frame.tunnelId, frame.id, 'remote-access not initialised');
      return;
    }

    const pathOnly = frame.path.split('?')[0] ?? frame.path;

    if (pathOnly === E2E_HTTP_PATH) {
      const bodyRaw = frame.body ? Buffer.from(frame.body, 'base64').toString('utf8') : '';
      try {
        const result = await handleE2eHttpFrame({
          tunnelId: frame.tunnelId,
          bodyRaw,
          localHost: bound.localHost,
          localPort: bound.localPort,
        });
        const out: ResFrame = {
          t: 'res',
          tunnelId: frame.tunnelId,
          id: frame.id,
          status: result.status,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(result.body, 'utf8').toString('base64'),
        };
        safeSend(out);
      } catch (err) {
        sendErr(
          socket,
          frame.tunnelId,
          frame.id,
          err instanceof Error ? err.message : 'E2E http failed',
        );
      }
      return;
    }

    const cookieRaw = frame.headers.cookie ?? frame.headers.Cookie;
    const rawCookieHeader = Array.isArray(cookieRaw)
      ? cookieRaw.join('; ')
      : typeof cookieRaw === 'string'
        ? cookieRaw
        : undefined;
    // A plaintext request is never authenticated. Drop any iclaw_ra session
    // cookie the browser still holds so (a) a returning visitor with stale
    // E2E state gets the gate to re-establish an encrypted session instead of
    // an "E2E required" dead-end, and (b) the workspace can never be served in
    // the clear off a lingering cookie. The workspace is reachable only via the
    // encrypted E2E loopback, which injects the session id itself.
    const cookieHeader = stripSessionCookie(rawCookieHeader);
    if (
      !isE2ePlaintextTunnelExempt({
        method: frame.method,
        path: pathOnly,
        tunnelId: frame.tunnelId,
        cookieHeader,
        accept: frame.headers.accept ?? frame.headers.Accept,
        secFetchMode: frame.headers['sec-fetch-mode'],
        secFetchDest: frame.headers['sec-fetch-dest'],
      })
    ) {
      sendE2eRequiredRes(frame.tunnelId, frame.id);
      return;
    }

    const safeHeaders = stripInternalHeaders(frame.headers);
    delete safeHeaders.cookie;
    delete safeHeaders.Cookie;
    if (cookieHeader) safeHeaders.cookie = cookieHeader;
    const reqOpts: http.RequestOptions = {
      host: bound.localHost,
      port: bound.localPort,
      method: frame.method,
      path: frame.path,
      headers: {
        ...safeHeaders,
        host: `${bound.localHost}:${bound.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
        [TUNNEL_ID_HEADER]: frame.tunnelId,
      },
    };

    await new Promise<void>((resolve) => {
      const lr = http.request(reqOpts, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          const body = Buffer.concat(chunks);
          const out: ResFrame = {
            t: 'res',
            tunnelId: frame.tunnelId,
            id: frame.id,
            status: resp.statusCode ?? 502,
            headers: stripHopByHop(resp.headers),
            body: body.length > 0 ? body.toString('base64') : '',
          };
          safeSend(out);
          resolve();
        });
        resp.on('error', (err) => {
          sendErr(socket, frame.tunnelId, frame.id, err.message);
          resolve();
        });
      });
      lr.on('error', (err) => {
        sendErr(socket, frame.tunnelId, frame.id, err.message);
        resolve();
      });
      if (frame.body) {
        lr.write(Buffer.from(frame.body, 'base64'));
      }
      lr.end();
    });
  })();
}

function sendErr(_socket: WebSocket, tunnelId: string, id: string | undefined, message: string): void {
  const f: ErrFrame = { t: 'err', tunnelId, message };
  if (id) f.id = id;
  safeSend(f);
}

function handleWsOpen(frame: WsOpenFrame): void {
  if (!bound) {
    sendStreamClose(frame.tunnelId, frame.id, 1011, 'remote-access not initialised');
    return;
  }
  const rt = tunnels.get(frame.tunnelId);
  if (!rt) {
    sendStreamClose(frame.tunnelId, frame.id, 1011, 'unknown tunnel');
    return;
  }

  const pathOnly = frame.path.split('?')[0] ?? frame.path;

  if (pathOnly === E2E_WS_PATH) {
    handleE2eWsOpen(frame.tunnelId, frame.id, rt.e2eWsBridges);
    return;
  }

  sendStreamClose(frame.tunnelId, frame.id, 4406, 'encrypted WebSocket required — use /__ra/e2e/ws');
}

function sendStreamClose(tunnelId: string, id: string, code?: number, reason?: string): void {
  const f: WsCloseFrame = { t: 'ws-close', tunnelId, id };
  if (code !== undefined) f.code = code;
  if (reason !== undefined) f.reason = reason;
  safeSend(f);
}

function handleWsData(frame: WsDataFrame): void {
  const rt = tunnels.get(frame.tunnelId);
  if (!rt) return;

  const e2eBridge = rt.e2eWsBridges.get(frame.id);
  if (e2eBridge && bound) {
    const dataRaw = Buffer.from(frame.data, 'base64').toString('utf8');
    handleE2eWsData({
      tunnelId: frame.tunnelId,
      streamId: frame.id,
      dataRaw,
      bridges: rt.e2eWsBridges,
      localHost: bound.localHost,
      localPort: bound.localPort,
      sendPublic: (wire) => {
        const f: WsDataFrame = {
          t: 'ws-data',
          tunnelId: frame.tunnelId,
          id: frame.id,
          binary: false,
          data: Buffer.from(wire, 'utf8').toString('base64'),
        };
        safeSend(f);
      },
    });
    return;
  }

  const s = rt.streams.get(frame.id);
  if (!s) return;
  if (s.ws.readyState === WebSocket.OPEN) {
    try {
      s.ws.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary });
    } catch {
      // ignore
    }
  } else if (s.ws.readyState === WebSocket.CONNECTING) {
    s.pending.push({ data: frame.data, binary: frame.binary });
  }
}

function handleWsCloseInbound(frame: WsCloseFrame): void {
  const rt = tunnels.get(frame.tunnelId);
  if (!rt) return;

  const e2eBridge = rt.e2eWsBridges.get(frame.id);
  if (e2eBridge) {
    closeE2eWsBridge(e2eBridge);
    rt.e2eWsBridges.delete(frame.id);
    return;
  }

  const s = rt.streams.get(frame.id);
  if (!s) return;
  rt.streams.delete(frame.id);
  try {
    s.ws.close(frame.code, frame.reason);
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------- connect -- */

function scheduleReconnect(): void {
  if (stopped) return;
  reconnectAttempt += 1;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (!bound || stopped) return;

  const socket = new WebSocket(bound.relayUrl);
  ws = socket;

  socket.on('open', () => {
    reconnectAttempt = 0;
    startWsKeepAlive(socket);
    rlog(`[remote-access] connected to relay (${bound!.relayUrl})`);
    // Re-register every active tunnel (relay restores the same subdomain).
    for (const rt of tunnels.values()) {
      registerOverWire(rt);
    }
  });

  socket.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    let frame: Frame | null = null;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;

    switch (frame.t) {
      case 'tunnel-registered':
        handleTunnelRegistered(frame);
        return;
      case 'tunnel-rejected':
        handleTunnelRejected(frame);
        return;
      case 'req':
        handleReq(socket, frame);
        return;
      case 'ws-open':
        handleWsOpen(frame);
        return;
      case 'ws-data':
        handleWsData(frame);
        return;
      case 'ws-close':
        handleWsCloseInbound(frame);
        return;
      case 'ping':
        safeSend({ t: 'pong' });
        return;
      // pong / register / unregister / res / err — relay shouldn't send these to us.
      default:
        return;
    }
  });

  socket.on('close', () => {
    if (ws !== socket) return;
    clearWsKeepAlive();
    ws = null;
    if (!stopped) {
      console.warn('[remote-access] disconnected, will retry');
      scheduleReconnect();
    }
  });

  socket.on('error', (err) => {
    console.warn(`[remote-access] ws error: ${err.message}`);
  });
}

function ensureConnection(): void {
  if (!bound || stopped) return;
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  connect();
}

/* ------------------------------------------------------------- internals -- */

/** Remove tunnel from in-memory map + clean up its streams + expiry timer. */
function removeTunnelLocal(tunnelId: string): void {
  const rt = tunnels.get(tunnelId);
  if (!rt) return;
  if (rt.expiryTimer) {
    clearTimeout(rt.expiryTimer);
    rt.expiryTimer = null;
  }
  for (const s of rt.streams.values()) {
    try {
      s.ws.close();
    } catch {
      // ignore
    }
  }
  rt.streams.clear();
  for (const b of rt.e2eWsBridges.values()) {
    closeE2eWsBridge(b);
  }
  rt.e2eWsBridges.clear();
  tunnels.delete(tunnelId);
  disableGate(tunnelId);
}

/** Disable a tunnel — local cleanup + tell relay + remove from persistence. */
function deleteTunnelImpl(tunnelId: string): boolean {
  const rt = tunnels.get(tunnelId);
  if (!rt) return false;
  unregisterOverWire(tunnelId);
  removeTunnelLocal(tunnelId);
  remoteAccessState.delete(tunnelId);
  rlog(`[remote-access:${tunnelId}] disabled`);
  return true;
}

async function bootstrapOpaqueForActiveTunnels(): Promise<void> {
  const active = remoteAccessState.list();
  if (active.length === 0) return;
  try {
    // Tunnels exist → an OPAQUE setup must exist too. Provision one if missing
    // (e.g. a previously-set OPAQUE_SERVER_SETUP env was removed) so resumed
    // tunnels re-register and stay loggable instead of silently failing.
    await ensureOpaqueServerSetup();
    await syncOpaqueRegistrationsWithServerSetup(
      active.map((p) => ({ id: p.id, passphrase: p.passphrase })),
    );
  } catch (err) {
    console.warn(
      `[remote-access] OPAQUE bootstrap failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/* ----------------------------------------------------------- public api -- */

export const remoteAccess = {
  configure(opts: { relayUrl: string; localHost: string; localPort: number }): void {
    bound = opts;
  },

  /** UI-driven activation with a bounded duration. */
  async createTunnel(durationMs: number, label?: string | null): Promise<TunnelStatus> {
    if (!ALLOWED_DURATIONS_MS.includes(durationMs)) {
      throw new Error(`invalid duration: ${durationMs}`);
    }
    if (!bound) {
      throw new Error('remote-access not configured');
    }
    const id = generateTunnelId();
    const passphrase = generatePassphrase();
    const now = Date.now();
    const persisted: PersistedTunnel = {
      id,
      label: label ?? null,
      passphrase,
      accessToken: generateAccessToken(),
      ownerSecret: generateOwnerSecret(),
      durationMs,
      startedAt: now,
      expiresAt: now + durationMs,
      createdAt: now,
    };
    remoteAccessState.save(persisted);

    try {
      await syncOpaqueRegistrationsWithServerSetup(
        remoteAccessState.list().map((p) => ({ id: p.id, passphrase: p.passphrase })),
      );
    } catch (err) {
      remoteAccessState.delete(id);
      throw err;
    }

    const rt = makeRuntime(persisted);
    tunnels.set(id, rt);
    enableGate(id, passphrase);
    scheduleExpiry(rt);

    rlog(
      `[remote-access:${id}] creating, duration=${Math.round(durationMs / 60_000)}min` +
        (label ? ` label="${label}"` : ''),
    );

    // Ensure WS is up; either send register now or it'll fire on 'open'.
    if (ws && ws.readyState === WebSocket.OPEN) {
      registerOverWire(rt);
    } else {
      ensureConnection();
    }

    return toStatus(rt);
  },

  deleteTunnel(id: string): boolean {
    if (!tunnels.has(id)) return false;
    return deleteTunnelImpl(id);
  },

  /**
   * Mint a new relay access token and URL. Invalidates previous ?access= links
   * and relay access cookies for this tunnel.
   */
  regenerateAccessToken(id: string): TunnelStatus | null {
    const rt = tunnels.get(id);
    const persisted = remoteAccessState.get(id);
    if (!rt || !persisted) return null;

    const newToken = generateAccessToken();
    persisted.accessToken = newToken;
    remoteAccessState.save(persisted);
    rt.accessToken = newToken;

    if (rt.currentUrl) {
      try {
        const u = new URL(rt.currentUrl);
        u.searchParams.delete(ACCESS_QUERY_PARAM);
        const base = u.pathname + u.search + u.hash;
        rt.currentUrl = buildPublicAccessUrl(`${u.origin}${base || '/'}`, newToken);
      } catch {
        // keep URL null until next tunnel-registered
        rt.currentUrl = null;
      }
    }

    registerOverWire(rt);
    rlog(`[remote-access:${id}] access link regenerated`);
    return toStatus(rt);
  },

  /** Re-attach persisted tunnels on startup. */
  resumeAll(): void {
    if (!bound) {
      console.warn('[remote-access] resumeAll called before configure');
      return;
    }
    const now = Date.now();
    let resumed = 0;
    for (const p of remoteAccessState.list().map(ensureAccessToken)) {
      if (p.expiresAt <= now) {
        remoteAccessState.delete(p.id);
        continue;
      }
      const rt = makeRuntime(p);
      tunnels.set(rt.id, rt);
      enableGate(p.id, p.passphrase);
      scheduleExpiry(rt);
      resumed += 1;
    }
    if (resumed > 0) {
      rlog(`[remote-access] resuming ${resumed} tunnel(s)`);
      ensureConnection();
      void bootstrapOpaqueForActiveTunnels();
    }
  },

  /** Process-shutdown stop. Drops WS + gates but keeps persisted state. */
  shutdown(): void {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearWsKeepAlive();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    for (const rt of tunnels.values()) {
      if (rt.expiryTimer) {
        clearTimeout(rt.expiryTimer);
        rt.expiryTimer = null;
      }
      for (const s of rt.streams.values()) {
        try {
          s.ws.close();
        } catch {
          // ignore
        }
      }
      rt.streams.clear();
      for (const b of rt.e2eWsBridges.values()) {
        closeE2eWsBridge(b);
      }
      rt.e2eWsBridges.clear();
    }
    tunnels.clear();
    disableAllGates();
  },

  getStatus(id: string): TunnelStatus | null {
    const rt = tunnels.get(id);
    return rt ? toStatus(rt) : null;
  },

  list(): TunnelStatus[] {
    // Sort: less remaining time on top, then by creation order.
    return Array.from(tunnels.values())
      .sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt)
      .map(toStatus);
  },

  isAnyEnabled(): boolean {
    return tunnels.size > 0;
  },
};
