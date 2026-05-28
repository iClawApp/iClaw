/**
 * Remote Access client.
 *
 * When enabled, iClaw opens an outbound WebSocket to a relay
 * (`ICLAW_RELAY_URL`). The relay allocates a temporary subdomain and
 * forwards public HTTP requests back to us as `req` frames; we replay them
 * against the local Express server over loopback and stream the response
 * back as a `res` frame.
 *
 * No auth / encryption layer yet — that lands in follow-up work
 * (invite-token, SPAKE2 password handshake, device keypairs).
 *
 * Activation:
 *   ICLAW_REMOTE_ACCESS=1
 *   ICLAW_RELAY_URL=ws://127.0.0.1:4100/tunnel    (or wss://… in production)
 *
 * Both vars must be set; otherwise `start()` is a no-op.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

import {
  enableGate,
  disableGate,
  generatePassphrase,
  isValidTunnelSession,
  stripInternalHeaders,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
} from './remoteAccessAuth';

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

function stripHopByHop(headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/* ----------------------------------------------------------------- state -- */

interface StartOptions {
  relayUrl: string;
  localHost: string;
  localPort: number;
}

let ws: WebSocket | null = null;
let stopped = false;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let opts: StartOptions | null = null;

/**
 * Open loopback WS streams, keyed by relay-side stream id. Bridges a
 * public-side WebSocket (in the browser) to the local iClaw `/ws` server.
 *
 * Each entry carries a `pending` queue so that `ws-data` frames arriving
 * while the loopback handshake is still in progress are flushed on
 * `open` instead of being silently dropped.
 */
interface StreamState {
  ws: WebSocket;
  pending: { data: string; binary: boolean }[];
}
const streams = new Map<string, StreamState>();

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
  if (!opts || stopped) return;

  const socket = new WebSocket(opts.relayUrl);
  ws = socket;

  socket.on('open', () => {
    reconnectAttempt = 0;
    console.log('[remote-access] connected to relay');
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
      console.log(`[remote-access] tunnel ready → ${frame.publicUrl}`);
      return;
    }
    if (frame.t === 'req') {
      void handleReq(socket, frame);
      return;
    }
    if (frame.t === 'ws-open') {
      handleWsOpen(socket, frame);
      return;
    }
    if (frame.t === 'ws-data') {
      const s = streams.get(frame.id);
      if (!s) return;
      if (s.ws.readyState === WebSocket.OPEN) {
        try {
          s.ws.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary });
        } catch {
          // peer probably closed mid-write
        }
      } else if (s.ws.readyState === WebSocket.CONNECTING) {
        // Loopback handshake still in flight; buffer until 'open' fires.
        s.pending.push({ data: frame.data, binary: frame.binary });
      }
      // CLOSING / CLOSED — silently drop.
      return;
    }
    if (frame.t === 'ws-close') {
      const s = streams.get(frame.id);
      if (s) {
        streams.delete(frame.id);
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
    // pong / err / unknown — ignore.
  });

  socket.on('close', () => {
    ws = null;
    if (!stopped) {
      console.warn('[remote-access] disconnected, will retry');
      scheduleReconnect();
    }
  });

  socket.on('error', (err) => {
    console.warn(`[remote-access] ws error: ${err.message}`);
    // 'close' will fire next and handle reconnect.
  });
}

function handleReq(socket: WebSocket, frame: ReqFrame): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!opts) {
      sendErr(socket, frame.id, 'remote-access not initialised');
      return resolve();
    }

    // Defence-in-depth: never let a public client pre-set the internal
    // `x-iclaw-tunneled` header on its way through the relay — strip it from
    // the incoming frame headers before we replay the request locally. We
    // then inject the header ourselves so the auth middleware can identify
    // genuinely tunneled traffic.
    const safeHeaders = stripInternalHeaders(frame.headers);

    const reqOpts: http.RequestOptions = {
      host: opts.localHost,
      port: opts.localPort,
      method: frame.method,
      path: frame.path,
      headers: {
        ...safeHeaders,
        host: `${opts.localHost}:${opts.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
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

/**
 * Open a loopback WebSocket connection to the local iClaw `/ws` (or
 * wherever the public client asked for) and bridge messages both ways
 * with the relay-side public WS via `ws-data` frames.
 *
 * Authentication: relay forwards the upgrade headers including any Cookie
 * the browser had. We require a valid `iclaw_ra` session before opening
 * the loopback — relay sees the cookie bytes pass through, but the gate
 * runs here, end-to-end of the local iClaw.
 */
function handleWsOpen(relayWs: WebSocket, frame: WsOpenFrame): void {
  if (!opts) {
    sendStreamClose(relayWs, frame.id, 1011, 'remote-access not initialised');
    return;
  }

  // Strip any forged x-iclaw-* headers from the public side (defence in
  // depth with the relay-side strip).
  const safeHeaders = stripInternalHeaders(frame.headers);

  if (!isValidTunnelSession(safeHeaders.cookie)) {
    // 4401 is in the application range; clients can distinguish from 1008.
    sendStreamClose(relayWs, frame.id, 4401, 'unauthorized');
    return;
  }

  const url = `ws://${opts.localHost}:${opts.localPort}${frame.path}`;
  let local: WebSocket;
  try {
    local = new WebSocket(url, {
      headers: {
        ...safeHeaders,
        host: `${opts.localHost}:${opts.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to open loopback ws';
    sendStreamClose(relayWs, frame.id, 1011, message);
    return;
  }
  const state: StreamState = { ws: local, pending: [] };
  streams.set(frame.id, state);

  local.on('open', () => {
    // Flush any frames that arrived during the loopback handshake.
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
    if (!streams.delete(frame.id)) return; // already closed-out by inbound ws-close
    sendStreamClose(
      relayWs,
      frame.id,
      code,
      reason && reason.length ? reason.toString('utf8') : undefined,
    );
  });

  local.on('error', (err) => {
    console.warn(`[remote-access] local ws error: ${err.message}`);
    // 'close' fires next and handles the frame.
  });
}

/* ----------------------------------------------------------- public api -- */

export const remoteAccess = {
  start(o: StartOptions): void {
    if (opts) {
      console.warn('[remote-access] already started, ignoring');
      return;
    }
    opts = o;
    stopped = false;
    reconnectAttempt = 0;

    // Fresh passphrase per remote-access session. Surfaced to the operator
    // via the iClaw process log; never sent to the relay (only POSTed by
    // the user through the tunnel and verified by us on the loopback side).
    const passphrase = generatePassphrase();
    enableGate(passphrase);
    console.log(`[remote-access] enabling, relay=${o.relayUrl} local=${o.localHost}:${o.localPort}`);
    console.log('[remote-access] ');
    console.log(`[remote-access]   passphrase:  ${passphrase}`);
    console.log('[remote-access]   share this with anyone you want to let in');
    console.log('[remote-access] ');
    connect();
  },

  stop(): void {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    opts = null;
    disableGate();
  },

  isEnabled(): boolean {
    return opts !== null && !stopped;
  },
};

/**
 * Read activation flags from env. Returns null if remote access is not
 * requested. Validates the relay URL eagerly so misconfiguration is loud.
 */
export function readRemoteAccessEnv(): { relayUrl: string } | null {
  const flag = process.env.ICLAW_REMOTE_ACCESS;
  if (flag !== '1' && flag !== 'true') return null;

  const relayUrl = process.env.ICLAW_RELAY_URL;
  if (!relayUrl) {
    console.warn('[remote-access] ICLAW_REMOTE_ACCESS is set but ICLAW_RELAY_URL is missing — skipping');
    return null;
  }

  try {
    const u = new URL(relayUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      console.warn(`[remote-access] ICLAW_RELAY_URL must use ws:// or wss:// (got ${u.protocol}) — skipping`);
      return null;
    }
  } catch {
    console.warn(`[remote-access] ICLAW_RELAY_URL is not a valid URL (${relayUrl}) — skipping`);
    return null;
  }

  return { relayUrl };
}
