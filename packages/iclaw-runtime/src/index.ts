/**
 * iClaw Runtime — HTTP server for the Work / Safe work / Incognito modes.
 *
 * Model-agnostic agent loop runs HERE on the host (via OpenRouter); tool/shell
 * execution is isolated in a per-turn Docker sandbox (secure-runner.ts /
 * work-container.ts). No SQLite — sessions live in memory + the secure-mode
 * workspace dir under ~/.iclaw/secure.
 *
 * API:
 *   POST   /sessions                  → { sessionId }
 *   POST   /sessions/:id/messages     → 202
 *   POST   /sessions/:id/abort        → 200 (stop in-flight turn, keep session)
 *   GET    /sessions/:id/events       → SSE stream
 *   DELETE /sessions/:id              → 200
 *   GET    /health                    → 200
 */
import http from 'node:http';

import { ensureColimaEnv } from './colima.js';
import { createSession, getSession, deleteSession, abortSession, attachSseClient, detachSseClient, sendMessage, getSessionInfo, exportSessionWorkspace, sweepExpiredSessions, startContainerReaper, loadPersistedSessions, type RuntimeAttachment } from './sessions.js';
import { killOrphanContainers } from './secure-runner.js';
import { startDockerIdleReaper, stopDockerOnShutdown } from './docker-lifecycle.js';
import { killOrphanWorkContainers } from './work-container.js';

// macOS: put colima/docker on PATH and route every `docker` call in this process
// (the container sandboxes in secure-runner.ts / work-container.ts included) to
// iClaw's Colima VM.
ensureColimaEnv();

const PORT = parseInt(process.env.ICLAW_RUNTIME_PORT || '7430', 10);
const SECRET = process.env.ICLAW_RUNTIME_SECRET || '';
const API_KEY = process.env.ICLAW_OPENROUTER_API_KEY || '';
// Default agent model. Override per-install via ICLAW_MODEL in .env.
const DEFAULT_MODEL = process.env.ICLAW_MODEL || 'minimax/minimax-m2.7';

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

  // GET /sessions/:id/info
  if (req.method === 'GET' && parts[0] === 'sessions' && parts[2] === 'info') {
    const info = getSessionInfo(parts[1]!);
    if (!info) return json(res, 404, { error: 'session not found' });
    return json(res, 200, info);
  }

  // POST /sessions
  if (req.method === 'POST' && parts[0] === 'sessions' && parts.length === 1) {
    const body = await readBody(req) as { allowedFolders?: string[]; folderAccess?: { path: string; readonly: boolean }[]; copyFolders?: string[]; model?: string; secure?: boolean; incognito?: boolean; projectId?: number | null; characterTools?: string[]; verification?: { judgeModel?: string; rubric?: string }; canCreateTasks?: boolean; autonomous?: boolean; systemPrompt?: string; key?: string; history?: { role: string; content: string }[] };
    // folderAccess (when present) is the source of truth for per-folder read/
    // write; derive allowedFolders paths from it so the two never drift.
    const folderAccess = Array.isArray(body.folderAccess)
      ? body.folderAccess
          .filter((f) => f && typeof f.path === 'string' && f.path)
          .map((f) => ({ path: f.path, readonly: f.readonly !== false }))
      : undefined;
    const allowedFolders = folderAccess
      ? folderAccess.map((f) => f.path)
      : (body.allowedFolders ?? []);
    const copyFolders = Array.isArray(body.copyFolders)
      ? body.copyFolders.filter((p) => typeof p === 'string' && p)
      : undefined;
    const sessionId = createSession({
      allowedFolders,
      folderAccess,
      copyFolders,
      model: body.model ?? DEFAULT_MODEL,
      apiKey: API_KEY,
      secure: body.secure ?? false,
      incognito: body.incognito ?? false,
      projectId: body.projectId ?? null,
      characterTools: body.characterTools,
      verification: body.verification,
      canCreateTasks: body.canCreateTasks ?? false,
      autonomous: body.autonomous ?? false,
      systemPrompt: body.systemPrompt,
      key: body.key,
      history: body.history,
    });
    return json(res, 201, { sessionId });
  }

  // POST /sessions/:id/messages
  if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'messages') {
    const sessionId = parts[1]!;
    if (!getSession(sessionId)) return json(res, 404, { error: 'session not found' });
    const body = await readBody(req) as { content?: string; networkEnabled?: boolean; ttlDays?: number; attachments?: RuntimeAttachment[]; copyFolders?: string[]; chatImages?: { path: string; fileName: string }[] };
    if (!body.content?.trim()) return json(res, 400, { error: 'content required' });
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter(
          (a): a is RuntimeAttachment =>
            !!a && typeof a.path === 'string' && !!a.path &&
            typeof a.mimeType === 'string' && typeof a.fileName === 'string',
        )
      : undefined;
    const copyFolders = Array.isArray(body.copyFolders)
      ? body.copyFolders.filter((p) => typeof p === 'string' && p)
      : undefined;
    const chatImages = Array.isArray(body.chatImages)
      ? body.chatImages.filter(
          (a): a is { path: string; fileName: string } =>
            !!a && typeof a.path === 'string' && !!a.path && typeof a.fileName === 'string',
        )
      : undefined;
    sendMessage(sessionId, body.content, body.networkEnabled, body.ttlDays, attachments, copyFolders, chatImages).catch(console.error);
    return json(res, 202, { queued: true });
  }

  // POST /sessions/:id/abort — stop the in-flight turn (keeps the session).
  if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'abort') {
    const sessionId = parts[1]!;
    if (!getSession(sessionId)) return json(res, 404, { error: 'session not found' });
    return json(res, 200, { aborted: abortSession(sessionId) });
  }

  // GET /sessions/:id/events (SSE)
  if (req.method === 'GET' && parts[0] === 'sessions' && parts[2] === 'events') {
    const sessionId = parts[1]!;
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

  // POST /sessions/:id/export — copy the Safe sandbox to a host folder.
  if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'export') {
    if (!getSession(parts[1]!)) return json(res, 404, { error: 'session not found' });
    const body = await readBody(req) as { destDir?: string };
    const result = exportSessionWorkspace(parts[1]!, typeof body.destDir === 'string' ? body.destDir : undefined);
    if (!result) return json(res, 400, { error: 'not a Safe session' });
    return json(res, 200, result);
  }

  // DELETE /sessions/:id
  if (req.method === 'DELETE' && parts[0] === 'sessions' && parts.length === 2) {
    deleteSession(parts[1]!);
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

// Periodic cleanup of expired sessions (every hour)
setInterval(() => {
  const removed = sweepExpiredSessions();
  if (removed > 0) console.error(`[iclaw-runtime] swept ${removed} expired session(s)`);
}, 3600_000).unref();

// Reap idle Secure-Mode sandbox containers (keeps RAM in check across chats).
startContainerReaper(30_000);

// Stop a Docker daemon WE started once it's idle and container-free (never
// touches a daemon the user started, nor one with running containers).
startDockerIdleReaper();

// Restore persisted Secure sessions so workspaces + TTL survive restarts
// (expired ones are deleted), then kill stray containers from the old process.
const { restored, expired } = loadPersistedSessions();
if (restored > 0 || expired > 0) {
  console.error(`[iclaw-runtime] restored ${restored} secure session(s), deleted ${expired} expired`);
}
killOrphanContainers()
  .then((n) => { if (n > 0) console.error(`[iclaw-runtime] killed ${n} orphan container(s)`); })
  .catch((err) => console.error('[iclaw-runtime] container cleanup failed', err));
killOrphanWorkContainers()
  .then((n) => { if (n > 0) console.error(`[iclaw-runtime] killed ${n} orphan work container(s)`); })
  .catch((err) => console.error('[iclaw-runtime] work container cleanup failed', err));

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop a Docker daemon WE started if it's idle/container-free (capped so a
  // hung Docker can't block the exit). No-op when we don't own it or a
  // container is still up — the durable marker is left for the next runtime.
  try {
    await stopDockerOnShutdown();
  } catch {
    /* best-effort */
  }
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
