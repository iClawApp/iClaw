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

type Frame = HelloFrame | ReqFrame | ResFrame | ErrFrame | { t: 'ping' } | { t: 'pong' };

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

    const reqOpts: http.RequestOptions = {
      host: opts.localHost,
      port: opts.localPort,
      method: frame.method,
      path: frame.path,
      headers: {
        ...frame.headers,
        host: `${opts.localHost}:${opts.localPort}`,
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
    console.log(`[remote-access] enabling, relay=${o.relayUrl} local=${o.localHost}:${o.localPort}`);
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
