/**
 * E2E transport — decrypt tunneled HTTP/WS envelopes and replay on loopback.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

import {
  decryptE2eRecord,
  decodeWireEnvelope,
  encodeWireEnvelope,
  encryptE2eRecord,
  type E2eFrameKind,
} from './remoteAccessE2eCrypto';
import {
  getE2eTransportSession,
  nextS2cCounter,
  type E2eTransportSession,
} from './remoteAccessE2eSession';
import {
  stripInternalHeaders,
  TUNNELED_HEADER,
  TUNNELED_VALUE,
  TUNNEL_ID_HEADER,
} from './remoteAccessAuth';

export const E2E_HTTP_PATH = '/__ra/e2e/http';
export const E2E_WS_PATH = '/__ra/e2e/ws';
export const E2E_BOOTSTRAP_PATH = '/__ra/e2e/bootstrap';

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

export interface InnerHttpReq {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface InnerHttpRes {
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface InnerWsOpen {
  path: string;
  headers: Record<string, string>;
}

export interface InnerWsData {
  binary: boolean;
  dataB64: string;
}

export interface InnerWsClose {
  code?: number;
  reason?: string;
}

export function isE2ePlaintextExemptPath(path: string): boolean {
  const p = path.split('?')[0] ?? path;
  if (p === E2E_HTTP_PATH || p === E2E_WS_PATH || p === E2E_BOOTSTRAP_PATH) return true;
  if (p.startsWith('/__ra/opaque/')) return true;
  if (p.startsWith('/__ra/device/')) return true;
  if (p === '/__ra/login') return true;
  if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/favicon')) return true;
  if (p === '/favicon.ico') return true;
  return false;
}

function decryptInbound(
  session: E2eTransportSession,
  wireRaw: string,
): { kind: E2eFrameKind; streamId: string; inner: Uint8Array } | null {
  const wire = decodeWireEnvelope(wireRaw);
  if (!wire || wire.sid !== session.handle) return null;
  const plain = decryptE2eRecord(
    session.keys,
    'c2s',
    {
      tunnelId: session.tunnelId,
      streamId: wire.streamId,
      ctr: wire.ctr,
      kind: wire.kind,
      ciphertext: wire.ciphertext,
      relayBinding: session.relayBinding,
    },
    session.c2sLedger,
  );
  if (!plain) return null;
  return { kind: plain.kind, streamId: plain.streamId, inner: plain.inner };
}

function encryptOutbound(
  session: E2eTransportSession,
  opts: { kind: E2eFrameKind; streamId: string; inner: Uint8Array },
): string {
  const ctr = nextS2cCounter(session, opts.streamId);
  const ciphertext = encryptE2eRecord(session.keys, 's2c', {
    tunnelId: session.tunnelId,
    streamId: opts.streamId,
    ctr,
    kind: opts.kind,
    inner: opts.inner,
    relayBinding: session.relayBinding,
  });
  return encodeWireEnvelope({
    sid: session.handle,
    ctr,
    kind: opts.kind,
    streamId: opts.streamId,
    ciphertext,
  });
}

function parseInnerJson<T>(inner: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(inner)) as T;
  } catch {
    return null;
  }
}

export interface E2eWsBridge {
  streamId: string;
  ready: boolean;
  local: WebSocket | null;
  pendingPublic: { dataB64: string; binary: boolean }[];
}

export async function handleE2eHttpFrame(opts: {
  tunnelId: string;
  bodyRaw: string;
  localHost: string;
  localPort: number;
}): Promise<{ status: number; body: string }> {
  const wire = decodeWireEnvelope(opts.bodyRaw);
  if (!wire) {
    return { status: 400, body: JSON.stringify({ error: 'invalid E2E envelope' }) };
  }
  const session = getE2eTransportSession(wire.sid);
  if (!session || session.tunnelId !== opts.tunnelId) {
    return { status: 403, body: JSON.stringify({ error: 'unknown E2E session' }) };
  }

  const decrypted = decryptInbound(session, opts.bodyRaw);
  if (!decrypted || decrypted.kind !== 'http-req') {
    return { status: 400, body: JSON.stringify({ error: 'invalid E2E http-req' }) };
  }

  const inner = parseInnerJson<InnerHttpReq>(decrypted.inner);
  if (!inner?.id || !inner.method || !inner.path) {
    return { status: 400, body: JSON.stringify({ error: 'malformed inner http-req' }) };
  }

  const safeHeaders = stripInternalHeaders(inner.headers ?? {});
  const reqOpts: http.RequestOptions = {
    host: opts.localHost,
    port: opts.localPort,
    method: inner.method,
    path: inner.path,
    headers: {
      ...safeHeaders,
      host: `${opts.localHost}:${opts.localPort}`,
      [TUNNELED_HEADER]: TUNNELED_VALUE,
      [TUNNEL_ID_HEADER]: opts.tunnelId,
    },
  };

  const httpRes = await new Promise<InnerHttpRes>((resolve, reject) => {
    const lr = http.request(reqOpts, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          id: inner.id,
          status: resp.statusCode ?? 502,
          headers: stripHopByHop(resp.headers),
          bodyB64: body.length > 0 ? body.toString('base64') : '',
        });
      });
      resp.on('error', reject);
    });
    lr.on('error', reject);
    if (inner.bodyB64) {
      lr.write(Buffer.from(inner.bodyB64, 'base64'));
    }
    lr.end();
  });

  const innerBytes = new TextEncoder().encode(JSON.stringify(httpRes));
  const wireOut = encryptOutbound(session, {
    kind: 'http-res',
    streamId: decrypted.streamId,
    inner: innerBytes,
  });

  return {
    status: 200,
    body: wireOut,
  };
}

export function handleE2eWsOpen(
  tunnelId: string,
  streamId: string,
  bridges: Map<string, E2eWsBridge>,
): E2eWsBridge {
  const bridge: E2eWsBridge = {
    streamId,
    ready: false,
    local: null,
    pendingPublic: [],
  };
  bridges.set(streamId, bridge);
  return bridge;
}

export function handleE2eWsData(opts: {
  tunnelId: string;
  streamId: string;
  dataRaw: string;
  bridges: Map<string, E2eWsBridge>;
  localHost: string;
  localPort: number;
  sendPublic: (wire: string, binary: boolean) => void;
}): void {
  const bridge = opts.bridges.get(opts.streamId);
  if (!bridge) return;

  const session = findSessionForWsData(opts.dataRaw);
  if (!session || session.tunnelId !== opts.tunnelId) return;

  const decrypted = decryptInbound(session, opts.dataRaw);
  if (!decrypted) return;

  if (decrypted.kind === 'ws-open') {
    const inner = parseInnerJson<InnerWsOpen>(decrypted.inner);
    if (!inner?.path) return;
    openLocalWs({
      bridge,
      session,
      tunnelId: opts.tunnelId,
      inner,
      localHost: opts.localHost,
      localPort: opts.localPort,
      sendPublic: opts.sendPublic,
    });
    return;
  }

  if (decrypted.kind === 'ws-data') {
    const inner = parseInnerJson<InnerWsData>(decrypted.inner);
    if (!inner) return;
    if (bridge.local && bridge.local.readyState === WebSocket.OPEN) {
      bridge.local.send(Buffer.from(inner.dataB64, 'base64'), { binary: inner.binary });
    } else if (bridge.local?.readyState === WebSocket.CONNECTING) {
      bridge.pendingPublic.push({ dataB64: inner.dataB64, binary: inner.binary });
    }
    return;
  }

  if (decrypted.kind === 'ws-close') {
    const inner = parseInnerJson<InnerWsClose>(decrypted.inner);
    if (bridge.local) {
      try {
        bridge.local.close(inner?.code, inner?.reason);
      } catch {
        // ignore
      }
    }
    opts.bridges.delete(opts.streamId);
  }
}

function findSessionForWsData(dataRaw: string): E2eTransportSession | null {
  const wire = decodeWireEnvelope(dataRaw);
  if (!wire) return null;
  return getE2eTransportSession(wire.sid);
}

function openLocalWs(opts: {
  bridge: E2eWsBridge;
  session: E2eTransportSession;
  tunnelId: string;
  inner: InnerWsOpen;
  localHost: string;
  localPort: number;
  sendPublic: (wire: string, binary: boolean) => void;
}): void {
  const safeHeaders = stripInternalHeaders(opts.inner.headers ?? {});
  const url = `ws://${opts.localHost}:${opts.localPort}${opts.inner.path}`;
  let local: WebSocket;
  try {
    local = new WebSocket(url, {
      headers: {
        ...safeHeaders,
        host: `${opts.localHost}:${opts.localPort}`,
        [TUNNELED_HEADER]: TUNNELED_VALUE,
        [TUNNEL_ID_HEADER]: opts.tunnelId,
      },
    });
  } catch {
    return;
  }
  opts.bridge.local = local;

  local.on('open', () => {
    opts.bridge.ready = true;
    for (const m of opts.bridge.pendingPublic) {
      local.send(Buffer.from(m.dataB64, 'base64'), { binary: m.binary });
    }
    opts.bridge.pendingPublic.length = 0;
  });

  local.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    const inner: InnerWsData = {
      binary: !!isBinary,
      dataB64: buf.toString('base64'),
    };
    const wire = encryptOutbound(opts.session, {
      kind: 'ws-data',
      streamId: opts.bridge.streamId,
      inner: new TextEncoder().encode(JSON.stringify(inner)),
    });
    opts.sendPublic(wire, false);
  });

  local.on('close', (code, reason) => {
    const inner: InnerWsClose = {
      code,
      reason: reason?.length ? reason.toString('utf8') : undefined,
    };
    const wire = encryptOutbound(opts.session, {
      kind: 'ws-close',
      streamId: opts.bridge.streamId,
      inner: new TextEncoder().encode(JSON.stringify(inner)),
    });
    opts.sendPublic(wire, false);
  });

  local.on('error', () => {
    // close handler follows
  });
}

export function closeE2eWsBridge(bridge: E2eWsBridge): void {
  if (bridge.local) {
    try {
      bridge.local.close();
    } catch {
      // ignore
    }
    bridge.local = null;
  }
}
