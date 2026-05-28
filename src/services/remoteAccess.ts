/**
 * Remote Access runtime — multi-tunnel.
 *
 * Each Remote Access tunnel is an independent unit: its own outbound WS
 * to the relay, its own subdomain, passphrase, expiry timer, and per-stream
 * loopback connections. Deleting one tunnel never affects another.
 *
 * Persisted state lives in {@link ./remoteAccessState.ts}; this module
 * mirrors it into in-memory {@link RuntimeTunnel} records that own the
 * actual WS plumbing.
 *
 * Activation paths:
 *   - UI: POST /api/remote-access/tunnels with a duration from the fixed
 *     list. Each call creates a new tunnel.
 *   - On iClaw startup: resumeAll() rehydrates every persisted tunnel
 *     whose `expiresAt` is still in the future.
 *
 * No env-driven path any more — the legacy `ICLAW_REMOTE_ACCESS=1` flag
 * was singleton-only and didn't fit the multi-tunnel model.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

import {
  enableGate,
  disableGate,
  disableAllGates,
  generatePassphrase,
  isValidTunnelSession,
  stripInternalHeaders,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
  TUNNEL_ID_HEADER,
} from './remoteAccessAuth';
import {
  generateTunnelId,
  remoteAccessState,
  type PersistedTunnel,
} from './remoteAccessState';

/* ---------------------------------------------------------------- frames -- */

interface HelloFrame {
  t: 'hello';
  subdomain: string;
  baseDomain: string;
  publicUrl: string;
}

interface ReqFrame {
  t: 'req';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface ResFrame {
  t: 'res';
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface ErrFrame {
  t: 'err';
  id?: string;
  message: string;
}

interface WsOpenFrame {
  t: 'ws-open';
  id: string;
  path: string;
  headers: Record<string, string>;
}

interface WsDataFrame {
  t: 'ws-data';
  id: string;
  binary: boolean;
  data: string;
}

interface WsCloseFrame {
  t: 'ws-close';
  id: string;
  code?: number;
  reason?: string;
}

type Frame =
  | HelloFrame
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
  headers:
    | http.IncomingHttpHeaders
    | Record<string, string | string[] | undefined>,
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
  id: string;
  label: string | null;
  passphrase: string;
  durationMs: number;
  startedAt: number;
  expiresAt: number;
  createdAt: number;

  ws: WebSocket | null;
  stopped: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
  currentUrl: string | null;
  streams: Map<string, StreamState>;
}

let bound: { relayUrl: string; localHost: string; localPort: number } | null = null;
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
  return {
    id: p.id,
    label: p.label,
    passphrase: p.passphrase,
    durationMs: p.durationMs,
    startedAt: p.startedAt,
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
    ws: null,
    stopped: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    expiryTimer: null,
    currentUrl: null,
    streams: new Map(),
  };
}

function scheduleExpiry(rt: RuntimeTunnel): void {
  if (rt.expiryTimer) {
    clearTimeout(rt.expiryTimer);
    rt.expiryTimer = null;
  }
  const delta = rt.expiresAt - Date.now();
  if (delta <= 0) {
    setTimeout(() => deleteTunnel(rt.id), 0);
    return;
  }
  rt.expiryTimer = setTimeout(() => {
    rt.expiryTimer = null;
    console.log(`[remote-access:${rt.id}] duration elapsed — stopping`);
    deleteTunnel(rt.id);
  }, delta);
  rt.expiryTimer.unref();
}

function scheduleReconnect(rt: RuntimeTunnel): void {
  if (rt.stopped) return;
  rt.reconnectAttempt += 1;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(rt.reconnectAttempt, 6));
  rt.reconnectTimer = setTimeout(() => {
    rt.reconnectTimer = null;
    connect(rt);
  }, delay);
}

function connect(rt: RuntimeTunnel): void {
  if (!bound || rt.stopped) return;

  const socket = new WebSocket(bound.relayUrl);
  rt.ws = socket;

  socket.on('open', () => {
    rt.reconnectAttempt = 0;
    console.log(`[remote-access:${rt.id}] connected to relay`);
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

    if (frame.t === 'hello') {
      rt.currentUrl = frame.publicUrl;
      console.log(`[remote-access:${rt.id}] tunnel ready → ${frame.publicUrl}`);
      return;
    }
    if (frame.t === 'req') {
      void handleReq(rt, socket, frame);
      return;
    }
    if (frame.t === 'ws-open') {
      handleWsOpen(rt, socket, frame);
      return;
    }
    if (frame.t === 'ws-data') {
      const s = rt.streams.get(frame.id);
      if (!s) return;
      if (s.ws.readyState === WebSocket.OPEN) {
        try {
          s.ws.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary });
        } catch {
          // peer probably closed mid-write
        }
      } else if (s.ws.readyState === WebSocket.CONNECTING) {
        s.pending.push({ data: frame.data, binary: frame.binary });
      }
      return;
    }
    if (frame.t === 'ws-close') {
      const s = rt.streams.get(frame.id);
      if (s) {
        rt.streams.delete(frame.id);
        try {
          s.ws.close(frame.code, frame.reason);
        } catch {
          // ignore
        }
      }
      return;
    }
    if (frame.t === 'ping') {
      socket.send(JSON.stringify({ t: 'pong' }));
      return;
    }
  });

  socket.on('close', () => {
    rt.ws = null;
    if (!rt.stopped) {
      console.warn(`[remote-access:${rt.id}] disconnected, will retry`);
      scheduleReconnect(rt);
    }
  });

  socket.on('error', (err) => {
    console.warn(`[remote-access:${rt.id}] ws error: ${err.message}`);
  });
}

function handleReq(
  rt: RuntimeTunnel,
  socket: WebSocket,
  frame: ReqFrame,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!bound) {
      sendErr(socket, frame.id, 'remote-access not initialised');
      return resolve();
    }

    const safeHeaders = stripInternalHeaders(frame.headers);

    const reqOpts: http.RequestOptions = {
      host: bound.localHost,
      port: bound.localPort,
      method: frame.method,
      path: frame.path,
      headers: {
        ...safeHeaders,
        host: `${bound.localHost}:${bound.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
        [TUNNEL_ID_HEADER]: rt.id,
      },
    };

    const lr = http.request(reqOpts, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => {
        const body = Buffer.concat(chunks);
        const out: ResFrame = {
          t: 'res',
          id: frame.id,
          status: resp.statusCode ?? 502,
          headers: stripHopByHop(resp.headers),
          body: body.length > 0 ? body.toString('base64') : '',
        };
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(out));
        }
        resolve();
      });
      resp.on('error', (err) => {
        sendErr(socket, frame.id, err.message);
        resolve();
      });
    });

    lr.on('error', (err) => {
      sendErr(socket, frame.id, err.message);
      resolve();
    });

    if (frame.body) {
      lr.write(Buffer.from(frame.body, 'base64'));
    }
    lr.end();
  });
}

function sendErr(socket: WebSocket, id: string | undefined, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const errFrame: ErrFrame = { t: 'err', id, message };
  socket.send(JSON.stringify(errFrame));
}

function sendStreamClose(
  socket: WebSocket,
  id: string,
  code?: number,
  reason?: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const f: WsCloseFrame = { t: 'ws-close', id, code, reason };
  try {
    socket.send(JSON.stringify(f));
  } catch {
    // ignore
  }
}

function handleWsOpen(
  rt: RuntimeTunnel,
  relayWs: WebSocket,
  frame: WsOpenFrame,
): void {
  if (!bound) {
    sendStreamClose(relayWs, frame.id, 1011, 'remote-access not initialised');
    return;
  }

  const safeHeaders = stripInternalHeaders(frame.headers);

  if (!isValidTunnelSession(rt.id, safeHeaders.cookie)) {
    sendStreamClose(relayWs, frame.id, 4401, 'unauthorized');
    return;
  }

  const url = `ws://${bound.localHost}:${bound.localPort}${frame.path}`;
  let local: WebSocket;
  try {
    local = new WebSocket(url, {
      headers: {
        ...safeHeaders,
        host: `${bound.localHost}:${bound.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
        [TUNNEL_ID_HEADER]: rt.id,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to open loopback ws';
    sendStreamClose(relayWs, frame.id, 1011, message);
    return;
  }
  const state: StreamState = { ws: local, pending: [] };
  rt.streams.set(frame.id, state);

  local.on('open', () => {
    for (const m of state.pending) {
      if (local.readyState !== WebSocket.OPEN) break;
      try {
        local.send(Buffer.from(m.data, 'base64'), { binary: m.binary });
      } catch {
        // ignore
      }
    }
    state.pending.length = 0;
  });

  local.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    const f: WsDataFrame = {
      t: 'ws-data',
      id: frame.id,
      binary: !!isBinary,
      data: buf.toString('base64'),
    };
    if (relayWs.readyState === WebSocket.OPEN) {
      try {
        relayWs.send(JSON.stringify(f));
      } catch {
        // ignore
      }
    }
  });

  local.on('close', (code, reason) => {
    if (!rt.streams.delete(frame.id)) return;
    sendStreamClose(
      relayWs,
      frame.id,
      code,
      reason && reason.length ? reason.toString('utf8') : undefined,
    );
  });

  local.on('error', (err) => {
    console.warn(`[remote-access:${rt.id}] local ws error: ${err.message}`);
  });
}

/* ----------------------------------------------------------- public api -- */

function closeRuntime(rt: RuntimeTunnel): void {
  rt.stopped = true;
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  if (rt.expiryTimer) {
    clearTimeout(rt.expiryTimer);
    rt.expiryTimer = null;
  }
  if (rt.ws) {
    try {
      rt.ws.close();
    } catch {
      // ignore
    }
    rt.ws = null;
  }
  for (const s of rt.streams.values()) {
    try {
      s.ws.close();
    } catch {
      // ignore
    }
  }
  rt.streams.clear();
}

function deleteTunnel(id: string): void {
  const rt = tunnels.get(id);
  if (!rt) return;
  closeRuntime(rt);
  tunnels.delete(id);
  disableGate(id);
  remoteAccessState.delete(id);
  console.log(`[remote-access:${id}] deleted`);
}

export const remoteAccess = {
  configure(opts: { relayUrl: string; localHost: string; localPort: number }): void {
    bound = opts;
  },

  /**
   * Create + start a fresh tunnel with the given duration. Returns the
   * new tunnel's status. URL will be null until the relay's `hello`
   * frame arrives (typically <1s after this returns).
   */
  createTunnel(durationMs: number, label?: string | null): TunnelStatus {
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
      durationMs,
      startedAt: now,
      expiresAt: now + durationMs,
      createdAt: now,
    };
    remoteAccessState.save(persisted);

    const rt = makeRuntime(persisted);
    tunnels.set(id, rt);
    enableGate(id, passphrase);
    scheduleExpiry(rt);

    console.log(
      `[remote-access:${id}] creating, relay=${bound.relayUrl} duration=${Math.round(durationMs / 60_000)}min`,
    );
    console.log(`[remote-access:${id}]   passphrase: ${passphrase}`);
    connect(rt);

    return toStatus(rt);
  },

  /** User-triggered "Disable" for one tunnel. */
  deleteTunnel(id: string): boolean {
    if (!tunnels.has(id)) return false;
    deleteTunnel(id);
    return true;
  },

  /** Re-attach every persisted tunnel whose `expires_at` is still in the future. */
  resumeAll(): void {
    if (!bound) {
      console.warn('[remote-access] resumeAll called before configure');
      return;
    }
    const now = Date.now();
    for (const p of remoteAccessState.list()) {
      if (p.expiresAt <= now) {
        remoteAccessState.delete(p.id);
        continue;
      }
      const rt = makeRuntime(p);
      tunnels.set(p.id, rt);
      enableGate(p.id, p.passphrase);
      scheduleExpiry(rt);
      console.log(
        `[remote-access:${p.id}] resuming, remaining=${Math.max(1, Math.round((p.expiresAt - now) / 60_000))}min`,
      );
      connect(rt);
    }
  },

  /**
   * Process-shutdown stop: close all sockets + drop gates, but DO NOT
   * touch persisted state — we want to auto-resume on next startup.
   */
  shutdown(): void {
    for (const rt of tunnels.values()) {
      closeRuntime(rt);
    }
    tunnels.clear();
    disableAllGates();
  },

  getStatus(id: string): TunnelStatus | null {
    const rt = tunnels.get(id);
    return rt ? toStatus(rt) : null;
  },

  list(): TunnelStatus[] {
    // Sort by time-until-expiry ascending: tunnels closest to expiring
    // rise to the top so the most-time-sensitive ones are the most
    // visible. Steady within a given duration (preserves create order).
    return Array.from(tunnels.values())
      .sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt)
      .map(toStatus);
  },

  isAnyEnabled(): boolean {
    return tunnels.size > 0;
  },
};
