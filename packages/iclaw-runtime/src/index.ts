/**
 * iClaw Runtime — Work Mode HTTP server.
 *
 * Model-agnostic agent loop via OpenRouter.
 * No Docker, no NanoClaw routing, no SQLite.
 *
 * API:
 *   POST   /sessions                  → { sessionId }
 *   POST   /sessions/:id/messages     → 202
 *   GET    /sessions/:id/events       → SSE stream
 *   DELETE /sessions/:id              → 200
 *   GET    /health                    → 200
 */
import http from 'node:http';

import { createSession, getSession, deleteSession, attachSseClient, detachSseClient, sendMessage } from './sessions.js';

const PORT = parseInt(process.env.ICLAW_RUNTIME_PORT || '7430', 10);
const SECRET = process.env.ICLAW_RUNTIME_SECRET || '';
const API_KEY = process.env.ICLAW_OPENROUTER_API_KEY || '';
const DEFAULT_MODEL = process.env.ICLAW_MODEL || 'google/gemini-2.5-flash';

function authOk(req: http.IncomingMessage): boolean {
  if (!SECRET) {
    const addr = req.socket.remoteAddress ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }
  return req.headers['x-iclaw-token'] === SECRET;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url ?? '/', `http://localhost`);
  const parts = url.pathname.split('/').filter(Boolean);

  // GET /health
  if (req.method === 'GET' && parts[0] === 'health') {
    return json(res, 200, { ok: true });
  }

  // POST /sessions
  if (req.method === 'POST' && parts[0] === 'sessions' && parts.length === 1) {
    const body = await readBody(req) as { allowedFolders?: string[]; model?: string; secure?: boolean; systemPrompt?: string };
    const sessionId = createSession({
      allowedFolders: body.allowedFolders ?? [],
      model: body.model ?? DEFAULT_MODEL,
      apiKey: API_KEY,
      secure: body.secure ?? false,
      systemPrompt: body.systemPrompt,
    });
    return json(res, 201, { sessionId });
  }

  // POST /sessions/:id/messages
  if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'messages') {
    const sessionId = parts[1];
    if (!getSession(sessionId)) return json(res, 404, { error: 'session not found' });
    const body = await readBody(req) as { content?: string; networkEnabled?: boolean };
    if (!body.content?.trim()) return json(res, 400, { error: 'content required' });
    sendMessage(sessionId, body.content, body.networkEnabled).catch(console.error);
    return json(res, 202, { queued: true });
  }

  // GET /sessions/:id/events (SSE)
  if (req.method === 'GET' && parts[0] === 'sessions' && parts[2] === 'events') {
    const sessionId = parts[1];
    if (!getSession(sessionId)) return json(res, 404, { error: 'session not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    attachSseClient(sessionId, res);
    req.on('close', () => detachSseClient(sessionId));
    return;
  }

  // DELETE /sessions/:id
  if (req.method === 'DELETE' && parts[0] === 'sessions' && parts.length === 2) {
    deleteSession(parts[1]);
    return json(res, 200, { stopped: true });
  }

  json(res, 404, { error: 'not found' });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[iclaw-runtime] port ${PORT} already in use — waiting 3s and retrying`);
    setTimeout(() => server.listen(PORT, '127.0.0.1'), 3000);
  } else {
    console.error('[iclaw-runtime] server error', err);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[iclaw-runtime] listening on port ${PORT}, model=${DEFAULT_MODEL}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
