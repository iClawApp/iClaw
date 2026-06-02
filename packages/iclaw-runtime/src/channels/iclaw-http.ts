/**
 * iClaw HTTP channel — replaces the CLI Unix socket channel.
 *
 * Exposes a simple HTTP API so the iClaw Next.js backend can:
 *   POST /sessions                    — create a work session
 *   POST /sessions/:id/messages       — send a user message
 *   GET  /sessions/:id/events         — SSE stream of agent output
 *   DELETE /sessions/:id              — stop session
 *
 * Wire format for SSE events:
 *   data: {"type":"text","content":"..."}
 *   data: {"type":"tool","name":"...","input":"..."}
 *   data: {"type":"done"}
 *   data: {"type":"error","message":"..."}
 *
 * Auth: shared secret via X-IClaw-Token header (set via ICLAW_RUNTIME_SECRET env).
 * If not configured, only localhost connections are accepted.
 */
import http from 'http';
import { randomUUID } from 'crypto';

import { DATA_DIR, RUNTIME_PORT } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const CHANNEL_TYPE = 'iclaw-http';
const PLATFORM_ID = 'iclaw';

const RUNTIME_SECRET = process.env.ICLAW_RUNTIME_SECRET || '';

/** Active SSE connections keyed by sessionId (= threadId). */
const sseClients = new Map<string, http.ServerResponse>();

/** Pending messages waiting for an SSE client to connect. */
const pendingDelivery = new Map<string, OutboundMessage[]>();

function authOk(req: http.IncomingMessage): boolean {
  if (!RUNTIME_SECRET) {
    // No secret configured — only allow loopback
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }
  return req.headers['x-iclaw-token'] === RUNTIME_SECRET;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function createAdapter(): ChannelAdapter {
  let server: http.Server | null = null;
  let setup: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'iclaw-http',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    isConnected(): boolean {
      return server !== null;
    },

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      server = http.createServer((req, res) => {
        if (!authOk(req)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }

        const url = new URL(req.url ?? '/', `http://localhost`);
        const parts = url.pathname.split('/').filter(Boolean);
        // POST /sessions
        if (req.method === 'POST' && parts[0] === 'sessions' && parts.length === 1) {
          handleCreateSession(req, res);
          return;
        }
        // POST /sessions/:id/messages
        if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'messages') {
          handleSendMessage(req, res, parts[1]);
          return;
        }
        // GET /sessions/:id/events (SSE)
        if (req.method === 'GET' && parts[0] === 'sessions' && parts[2] === 'events') {
          handleSseSubscribe(req, res, parts[1]);
          return;
        }
        // DELETE /sessions/:id
        if (req.method === 'DELETE' && parts[0] === 'sessions' && parts.length === 2) {
          handleDeleteSession(req, res, parts[1]);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      });

      server.listen(RUNTIME_PORT, '127.0.0.1', () => {
        log.info('iClaw HTTP channel listening', { port: RUNTIME_PORT });
      });
    },

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      const sessionId = threadId ?? platformId;
      const client = sseClients.get(sessionId);
      if (client && !client.writableEnded) {
        writeSseEvent(client, message);
      } else {
        // Buffer until client connects
        const buf = pendingDelivery.get(sessionId) ?? [];
        buf.push(message);
        pendingDelivery.set(sessionId, buf);
      }
      return undefined;
    },

    async teardown(): Promise<void> {
      server?.close();
      for (const res of sseClients.values()) {
        res.end();
      }
      sseClients.clear();
    },
  };

  function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { sessionId: requestedId, allowedFolders, model } = JSON.parse(body || '{}');
        const sessionId: string = requestedId ?? randomUUID();
        // Notify the router that this session is now active
        setup?.onInbound(PLATFORM_ID, sessionId, {
          id: randomUUID(),
          kind: 'chat',
          content: JSON.stringify({ text: '__iclaw_session_init__', allowedFolders, model }),
          timestamp: new Date().toISOString(),
        });
        sendJson(res, 201, { sessionId });
      } catch (err) {
        sendJson(res, 400, { error: 'invalid body' });
      }
    });
  }

  function handleSendMessage(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { content } = JSON.parse(body || '{}');
        if (typeof content !== 'string' || !content.trim()) {
          sendJson(res, 400, { error: 'content required' });
          return;
        }
        setup?.onInbound(PLATFORM_ID, sessionId, {
          id: randomUUID(),
          kind: 'chat',
          content: JSON.stringify({ text: content }),
          timestamp: new Date().toISOString(),
        });
        sendJson(res, 202, { queued: true });
      } catch {
        sendJson(res, 400, { error: 'invalid body' });
      }
    });
  }

  function handleSseSubscribe(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    sseClients.set(sessionId, res);

    // Flush any buffered messages
    const pending = pendingDelivery.get(sessionId);
    if (pending) {
      for (const msg of pending) writeSseEvent(res, msg);
      pendingDelivery.delete(sessionId);
    }

    req.on('close', () => {
      sseClients.delete(sessionId);
    });
  }

  function handleDeleteSession(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    const client = sseClients.get(sessionId);
    if (client) {
      writeSseEvent(client, { kind: 'text', content: JSON.stringify({ type: 'done' }) });
      client.end();
      sseClients.delete(sessionId);
    }
    // Notify router to tear down container
    setup?.onInbound(PLATFORM_ID, sessionId, {
      id: randomUUID(),
      kind: 'chat',
      content: JSON.stringify({ text: '__iclaw_session_stop__' }),
      timestamp: new Date().toISOString(),
    });
    sendJson(res, 200, { stopped: true });
  }

  function writeSseEvent(res: http.ServerResponse, message: OutboundMessage): void {
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(message.content as string);
      } catch {
        payload = { type: 'text', content: message.content };
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client gone — ignore
    }
  }

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
