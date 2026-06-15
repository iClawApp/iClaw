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
  allowedFolders?: string[] | undefined;
  /**
   * Per-folder access levels. When provided, the runtime enforces read-only
   * folders (denies write_file / run_command under them) and derives the
   * allowed-path list from it.
   */
  folderAccess?: { path: string; readonly: boolean }[] | undefined;
  /**
   * Safe Mode only: host folders to COPY into the sandbox workspace (originals
   * never touched). Ignored in Work Mode, which bind-mounts folders live.
   */
  copyFolders?: string[] | undefined;
  model?: string | undefined;
  secure?: boolean | undefined;
  /** Incognito: read-only, read-anywhere, web_fetch enabled. Mutually exclusive with secure. */
  incognito?: boolean | undefined;
  /** Active project id (or null) — picks the per-project browser profile for browser_* tools. */
  projectId?: number | null | undefined;
  /** Character tool allowlist (by name) — narrows the turn's tools to the character's job. */
  characterTools?: string[] | undefined;
  /** Specialist chat: offer the create_task tool so the model can spin up a task. */
  canCreateTasks?: boolean | undefined;
  /** Autonomous run: raise the round ceiling (200) + offer the set_timer tool. */
  autonomous?: boolean | undefined;
  systemPrompt?: string | undefined;
  /** Stable identity (e.g. "chat:156") so a chat reconnects to its workspace. */
  key?: string | undefined;
  /** Compacted prior history to seed context (used after a restart). */
  history?: { role: string; content: string }[] | undefined;
}

/** Create a new Work Mode session. Returns sessionId. */
export async function createWorkSession(opts: CreateSessionOptions = {}): Promise<string> {
  const body: Record<string, unknown> = { allowedFolders: opts.allowedFolders, secure: opts.secure };
  if (opts.incognito) body.incognito = true;
  if (opts.projectId != null) body.projectId = opts.projectId;
  if (opts.characterTools?.length) body.characterTools = opts.characterTools;
  if (opts.canCreateTasks) body.canCreateTasks = true;
  if (opts.autonomous) body.autonomous = true;
  if (opts.folderAccess?.length) body.folderAccess = opts.folderAccess;
  if (opts.copyFolders?.length) body.copyFolders = opts.copyFolders;
  if (opts.model) body.model = opts.model;
  if (opts.systemPrompt) body.systemPrompt = opts.systemPrompt;
  if (opts.key) body.key = opts.key;
  if (opts.history?.length) body.history = opts.history;
  const res = await request('POST', '/sessions', body);
  if (res.status !== 201) {
    throw new Error(`Failed to create work session: ${JSON.stringify(res.data)}`);
  }
  return (res.data as { sessionId: string }).sessionId;
}

/** A dropped file forwarded to the runtime: absolute host path + metadata. */
export interface RuntimeAttachmentInput {
  path: string;
  mimeType: string;
  fileName: string;
}

/** Send a user message to a work session. */
export async function sendWorkMessage(sessionId: string, content: string, networkEnabled?: boolean, ttlDays?: number, attachments?: RuntimeAttachmentInput[], copyFolders?: string[], chatImages?: { path: string; fileName: string }[]): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (networkEnabled !== undefined) body.networkEnabled = networkEnabled;
  if (ttlDays !== undefined) body.ttlDays = ttlDays;
  if (attachments?.length) body.attachments = attachments;
  // Safe Mode: lets the runtime copy folders the user added mid-chat into the
  // sandbox on this turn (ignored in Work Mode / by non-secure sessions).
  if (copyFolders?.length) body.copyFolders = copyFolders;
  // Work Mode: this chat's earlier photos (uploaded or agent-generated) as host
  // paths, so a follow-up "edit it" turn can reach them via edit_image.
  if (chatImages?.length) body.chatImages = chatImages;
  const res = await request('POST', `/sessions/${sessionId}/messages`, body);
  if (res.status !== 202) {
    throw new Error(`Failed to send work message: ${JSON.stringify(res.data)}`);
  }
}

/** Stop a work session. */
export async function stopWorkSession(sessionId: string): Promise<void> {
  await request('DELETE', `/sessions/${sessionId}`);
}

/**
 * Abort the in-flight turn for a session WITHOUT destroying it (workspace +
 * container survive — unlike stopWorkSession). Backs the Stop button for
 * Work / Secure / Incognito turns.
 */
export async function abortWorkSession(sessionId: string): Promise<void> {
  await request('POST', `/sessions/${sessionId}/abort`);
}

/** A "saved N% cost" note from the runtime (e.g. analyze_link summary mode). */
export interface RuntimeSavingsNote {
  kind: string;
  /** Short human label for the source, e.g. "video transcript". */
  source: string;
  /** Whole-percent saved. Absent for quantity-free notes (search line-trimming). */
  savedPct?: number;
  fullChars?: number;
  deliveredChars?: number;
}

export type WorkEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_result'; name: string; result?: string }
  | { type: 'note'; note: RuntimeSavingsNote }
  | { type: 'image'; path: string; mime: string; fileName: string; bytes: number; generated?: boolean }
  | { type: 'create_task'; title: string; goal: string }
  | { type: 'plan'; steps: { step: string; status: 'pending' | 'in_progress' | 'done' }[] }
  | { type: 'set_timer'; seconds: number; note: string }
  | { type: 'calendar'; entries: { date: string; text: string; platform: string; status: 'idea' | 'draft' }[] }
  | { type: 'reminder'; event: string; date: string; leadDays: number[]; recurring: 'none' | 'yearly' }
  | { type: 'done'; tokens?: number; cached?: number; reasoning?: number }
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

/** Get workspace info for a session. */
export async function getWorkspaceInfo(sessionId: string): Promise<{ workspaceSize: number; secure: boolean } | null> {
  try {
    const res = await request('GET', `/sessions/${sessionId}/info`);
    if (res.status !== 200) return null;
    return res.data as { workspaceSize: number; secure: boolean };
  } catch { return null; }
}

export interface ExportResult { ok: boolean; path?: string; files?: number; error?: string }

/** Export a Safe sandbox to a host folder (default ~/Downloads). */
export async function exportSandbox(sessionId: string, destDir?: string): Promise<ExportResult> {
  const res = await request('POST', `/sessions/${sessionId}/export`, destDir ? { destDir } : {});
  if (res.status !== 200) throw new Error(`Export failed: ${JSON.stringify(res.data)}`);
  return res.data as ExportResult;
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
