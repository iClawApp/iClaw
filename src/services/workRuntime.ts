/**
 * iClaw Work Mode runtime client.
 *
 * Communicates with the `@iclaw/runtime` service (packages/iclaw-runtime)
 * over HTTP. The runtime runs as a sidecar process on the same host.
 *
 * The runtime exposes:
 *   POST /sessions                 → { sessionId }
 *   POST /sessions/:id/messages    → 202
 *   GET  /sessions/:id/events      → SSE stream
 *   DELETE /sessions/:id           → stop
 */
import http from 'http';

const RUNTIME_PORT = parseInt(process.env.ICLAW_RUNTIME_PORT || '7430', 10);
const RUNTIME_SECRET = process.env.ICLAW_RUNTIME_SECRET || '';

function runtimeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (RUNTIME_SECRET) h['x-iclaw-token'] = RUNTIME_SECRET;
  return h;
}

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : undefined;
    const headers = runtimeHeaders();
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();

    const req = http.request(
      { hostname: '127.0.0.1', port: RUNTIME_PORT, path, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface CreateSessionOptions {
  allowedFolders?: string[];
  model?: string;
  secure?: boolean;
}

/** Create a new Work Mode session. Returns sessionId. */
export async function createWorkSession(opts: CreateSessionOptions = {}): Promise<string> {
  const res = await request('POST', '/sessions', opts);
  if (res.status !== 201) {
    throw new Error(`Failed to create work session: ${JSON.stringify(res.data)}`);
  }
  return (res.data as { sessionId: string }).sessionId;
}

/** Send a user message to a work session. */
export async function sendWorkMessage(sessionId: string, content: string): Promise<void> {
  const res = await request('POST', `/sessions/${sessionId}/messages`, { content });
  if (res.status !== 202) {
    throw new Error(`Failed to send work message: ${JSON.stringify(res.data)}`);
  }
}

/** Stop a work session. */
export async function stopWorkSession(sessionId: string): Promise<void> {
  await request('DELETE', `/sessions/${sessionId}`);
}

export type WorkEvent =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; input?: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Subscribe to SSE events from a work session.
 * Calls `onEvent` for each event, resolves when stream closes.
 */
export function subscribeWorkEvents(
  sessionId: string,
  onEvent: (event: WorkEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const headers = runtimeHeaders();
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: RUNTIME_PORT,
      path: `/sessions/${sessionId}/events`,
      method: 'GET',
      headers,
    },
    (res) => {
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as WorkEvent;
              onEvent(event);
            } catch {
              // ignore malformed SSE lines
            }
          }
        }
      });
      res.on('end', () => onEvent({ type: 'done' }));
      res.on('error', (err) => onError?.(err));
    },
  );
  req.on('error', (err) => onError?.(err));
  req.end();

  return () => req.destroy();
}

/** True if the runtime service appears to be running. */
export async function runtimeAvailable(): Promise<boolean> {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
}
