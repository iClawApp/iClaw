/**
 * In-memory session manager for Work and Secure modes.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync, readFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { runAgentTurn, type Message } from './agent/loop.js';
import type { AgentEvent } from './agent/loop.js';
import { validateMountRoot } from './agent/security.js';
import {
  runSecureTurn, createSecureWorkspace, destroySecureWorkspace,
  startContainer, stopContainer, isContainerRunning,
  writeSessionMeta, listPersistedWorkspaces,
} from './secure-runner.js';
import {
  resolveWorkImage, startWorkContainer, execInWorkContainer,
  toWorkMounts, type WorkMount,
} from './work-container.js';
import { ingestSources, describeIngest, type IngestSource } from './secure-ingest.js';
import {
  exportWorkspace, type ExportResult,
} from './secure-export.js';
import { ensureDockerForTask, markDockerUse } from './docker-lifecycle.js';

export interface SessionOptions {
  allowedFolders: string[];
  /**
   * Per-folder access levels (path + readonly flag), parallel to allowedFolders.
   * When omitted, every allowed folder is treated as writable. Used by Work Mode
   * to enforce read-only folders; Secure Mode leaves it unset (workspace is RW).
   */
  folderAccess?: { path: string; readonly: boolean }[] | undefined;
  /**
   * Safe Mode only: host folders to COPY into the sandbox workspace on the first
   * turn (originals never touched). Realizes "I added a folder and it got copied
   * into the sandbox" — distinct from Work Mode's live bind mounts.
   */
  copyFolders?: string[] | undefined;
  model: string;
  apiKey: string;
  secure?: boolean | undefined;
  /**
   * Incognito (read-only, ephemeral): runs the host loop like Work, but writes
   * are denied, reads are unrestricted, the shell sandbox forces every folder
   * to :ro, and web_fetch is available. Mutually exclusive with `secure`.
   */
  incognito?: boolean | undefined;
  networkEnabled?: boolean | undefined;
  systemPrompt?: string | undefined;
  /** Persona mode: no tools, no Docker — a plain conversation with the model. */
  chatOnly?: boolean | undefined;
  /** Character tool allowlist (by name) — narrows the turn's tools. */
  characterTools?: string[] | undefined;
  /** Stable identity (e.g. "chat:156") for reconnecting to a workspace. */
  key?: string | undefined;
  /**
   * Optional compacted prior history (from the host's DB) used to seed context
   * after a restart. Only applied when the session has no history yet — never
   * clobbers a live session's accumulated context.
   */
  history?: { role: string; content: string }[] | undefined;
}

/**
 * A file the user dropped into the chat, forwarded from the host. `path` is the
 * absolute on-disk location of the persisted upload (the runtime shares the
 * host filesystem), so the runtime can read it directly — to stage it into a
 * Secure workspace, grant Work read access, or base64 an image for vision.
 */
export interface RuntimeAttachment {
  path: string;
  mimeType: string;
  fileName: string;
}

interface Session {
  id: string;
  opts: SessionOptions;
  history: Message[];
  sseClient: http.ServerResponse | null;
  pending: AgentEvent[];
  /** Persistent workspace dir for Secure Mode (survives container restarts). */
  secureWorkspaceDir?: string;
  /** Safe Mode: folder paths already copied into the workspace (ingest once each). */
  ingestedFolders?: Set<string>;
  /**
   * Warm Secure-Mode sandbox container, reused across turns. Recreated only
   * when the network setting changes or after the container is reaped for idle;
   * the workspace dir outlives it either way.
   */
  secureContainer?: { name: string; networkEnabled: boolean; lastUsed: number; inUse: boolean } | undefined;
  /**
   * Warm Work-Mode command sandbox, reused across turns (parallel to
   * secureContainer — a session is exactly one mode). Holds the user's chosen
   * folders bind-mounted :ro/:rw; only run_command runs inside it.
   */
  workContainer?: { name: string; lastUsed: number; inUse: boolean } | undefined;
  /** Stable identity for reconnection across restarts. */
  key?: string | undefined;
  /** Last activity timestamp (ms). Updated on each message. */
  lastActivity: number;
  /** TTL in ms after last activity before cleanup. 0 = never. Default 7 days. */
  ttlMs: number;
  /** Controller for the in-flight turn — abort() stops the model stream and
   *  ends the agent loop (user pressed Stop). Set per turn, cleared after. */
  abort?: AbortController | undefined;
}

const DEFAULT_TTL_MS = 7 * 86400_000;
// Warm container idle reap: many chats → keep this short so idle sandboxes
// don't pile up RAM. (The workspace dir persists; only the container is freed.)
const CONTAINER_IDLE_MS = 2 * 60_000;
// Cap concurrent warm sandbox containers; LRU-evict the rest.
const MAX_WARM_CONTAINERS = 4;

// Live-session re-compaction: once in-memory history exceeds the trigger, fold
// the older turns into a summary so a long-running session (no restart) keeps a
// bounded context instead of growing unbounded. Tunable via env.
const HISTORY_COMPACT_TRIGGER = Number(process.env.ICLAW_HISTORY_COMPACT_TRIGGER) || 40;
const HISTORY_KEEP_RECENT = Number(process.env.ICLAW_HISTORY_KEEP_RECENT) || 16;
// Also compact by SIZE, not just message count: a few big messages bloat the
// resent context as much as many small ones. ~24k chars ≈ ~6k tokens.
const HISTORY_COMPACT_CHARS = Number(process.env.ICLAW_HISTORY_COMPACT_CHARS) || 24_000;
const SUMMARY_MODEL = process.env.ICLAW_SUMMARY_MODEL || 'minimax/minimax-m2.7';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, '') || 'https://openrouter.ai/api/v1';
const SUMMARY_SYSTEM =
  'You compress conversation history into a concise, information-dense summary. ' +
  'Preserve facts, decisions, user preferences, names, numbers, file/work state, and open threads. ' +
  'Merge any existing summary with the new messages. Output only the summary.';
const sessions = new Map<string, Session>();
// Maps a stable key (e.g. "chat:156") to the current in-memory session id, so a
// chat reconnects to the same persisted workspace after a restart.
const keyToId = new Map<string, string>();

/** Persist TTL/activity metadata so the session survives a runtime restart. */
function persistMeta(session: Session): void {
  if (!session.opts.secure || !session.secureWorkspaceDir) return;
  writeSessionMeta(session.secureWorkspaceDir, {
    key: session.key,
    lastActivity: session.lastActivity,
    ttlMs: session.ttlMs,
    secure: true,
    model: session.opts.model,
  });
}

/**
 * Create a session, or — if a stable `key` is given and a live session already
 * exists for it — reuse it (refreshing runtime params like model/systemPrompt/
 * apiKey while preserving the workspace, history, TTL and lastActivity).
 */
export function createSession(opts: SessionOptions): string {
  if (opts.key) {
    const existingId = keyToId.get(opts.key);
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) {
      // Reconnect: keep state, refresh the volatile runtime params.
      existing.opts = { ...existing.opts, ...opts };
      // Seed context only if empty (e.g. restored-from-disk after a restart) —
      // never clobber a live session's accumulated history.
      if (existing.history.length === 0) seedHistory(existing, opts.history);
      return existing.id;
    }
  }

  const id = randomUUID();
  const session: Session = {
    id, opts, history: [], sseClient: null, pending: [],
    key: opts.key, lastActivity: Date.now(), ttlMs: DEFAULT_TTL_MS,
  };
  seedHistory(session, opts.history);
  if (opts.secure) {
    session.secureWorkspaceDir = createSecureWorkspace();
  }
  sessions.set(id, session);
  if (opts.key) keyToId.set(opts.key, id);
  persistMeta(session);
  return id;
}

/** Seed a session's history from compacted prior turns (host-supplied). */
function seedHistory(session: Session, history?: { role: string; content: string }[]): void {
  if (!history?.length) return;
  session.history = history.map((m) => ({ role: m.role, content: m.content }) as Message);
}

/** Set TTL (days) for a session. 0 = never expire. */
export function setSessionTtl(id: string, ttlDays: number): void {
  const session = sessions.get(id);
  if (session) {
    session.ttlMs = ttlDays <= 0 ? 0 : ttlDays * 86400_000;
    persistMeta(session);
  }
}

/**
 * Reload persisted Secure sessions at startup so workspaces (and their TTL)
 * survive a runtime restart. Expired ones are deleted; the rest become live
 * shell sessions that a chat reconnects to via its key. apiKey comes from env;
 * model/systemPrompt are refreshed when the host next calls createSession.
 */
export function loadPersistedSessions(): { restored: number; expired: number } {
  const now = Date.now();
  let restored = 0;
  let expired = 0;
  const apiKey = process.env.ICLAW_OPENROUTER_API_KEY || '';

  for (const { dir, meta } of listPersistedWorkspaces()) {
    if (!meta || (meta.ttlMs > 0 && now - meta.lastActivity > meta.ttlMs)) {
      destroySecureWorkspace(dir);
      expired++;
      continue;
    }
    const id = randomUUID();
    const session: Session = {
      id,
      opts: {
        allowedFolders: [dir],
        model: meta.model || (process.env.ICLAW_MODEL || ''),
        apiKey,
        secure: true,
      },
      history: [],
      sseClient: null,
      pending: [],
      secureWorkspaceDir: dir,
      key: meta.key,
      lastActivity: meta.lastActivity,
      ttlMs: meta.ttlMs,
    };
    sessions.set(id, session);
    if (meta.key) keyToId.set(meta.key, id);
    restored++;
  }
  return { restored, expired };
}

/** Sweep expired sessions — destroys workspace + frees memory. Runs periodically. */
export function sweepExpiredSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.ttlMs > 0 && now - session.lastActivity > session.ttlMs) {
      if (session.secureContainer) stopContainer(session.secureContainer.name);
      if (session.workContainer) stopContainer(session.workContainer.name);
      if (session.secureWorkspaceDir) destroySecureWorkspace(session.secureWorkspaceDir);
      if (session.key) keyToId.delete(session.key);
      session.sseClient?.end();
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Stop warm Secure containers that have been idle longer than CONTAINER_IDLE_MS.
 * The session and its workspace dir survive — the next message re-creates the
 * container. Driven by a short interval (startContainerReaper).
 */
export function reapIdleContainers(): number {
  const now = Date.now();
  let reaped = 0;
  for (const session of sessions.values()) {
    const c = session.secureContainer;
    if (c && !c.inUse && now - c.lastUsed > CONTAINER_IDLE_MS) {
      stopContainer(c.name);
      session.secureContainer = undefined;
      reaped++;
    }
    const w = session.workContainer;
    if (w && !w.inUse && now - w.lastUsed > CONTAINER_IDLE_MS) {
      stopContainer(w.name);
      session.workContainer = undefined;
      reaped++;
    }
  }
  return reaped;
}

/** Start the idle-container reaper. Returns a stop handle. */
export function startContainerReaper(intervalMs = 30_000): () => void {
  const t = setInterval(reapIdleContainers, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * Ensure the session has a running sandbox container matching `networkEnabled`,
 * reusing the existing one when possible (warm reuse). Recreates it when the
 * network setting changed or the old container died. Enforces a global cap on
 * concurrent warm containers by LRU-evicting the least recently used.
 *
 * Throws (fail-closed) if Docker can't start the sandbox.
 */
async function ensureSecureContainer(session: Session, networkEnabled: boolean): Promise<string> {
  const existing = session.secureContainer;
  if (existing && existing.networkEnabled === networkEnabled && await isContainerRunning(existing.name)) {
    existing.lastUsed = Date.now();
    return existing.name;
  }
  // Stale, dead, or network setting changed → drop the old one.
  if (existing) {
    stopContainer(existing.name);
    session.secureContainer = undefined;
  }

  evictWarmContainersIfNeeded(session);

  const name = await startContainer(session.secureWorkspaceDir!, networkEnabled);
  session.secureContainer = { name, networkEnabled, lastUsed: Date.now(), inUse: false };
  return name;
}

/**
 * LRU-evict warm containers (excluding `keep`) until under the cap. Counts both
 * Secure and Work sandboxes — a session has at most one, and both consume RAM.
 */
function evictWarmContainersIfNeeded(keep: Session): void {
  type Warm = { session: Session; kind: 'secure' | 'work'; name: string; lastUsed: number };
  const warm: Warm[] = [];
  for (const s of sessions.values()) {
    if (s === keep) continue;
    if (s.secureContainer && !s.secureContainer.inUse) {
      warm.push({ session: s, kind: 'secure', name: s.secureContainer.name, lastUsed: s.secureContainer.lastUsed });
    }
    if (s.workContainer && !s.workContainer.inUse) {
      warm.push({ session: s, kind: 'work', name: s.workContainer.name, lastUsed: s.workContainer.lastUsed });
    }
  }
  while (warm.length >= MAX_WARM_CONTAINERS) {
    warm.sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = warm.shift();
    if (!victim) break;
    stopContainer(victim.name);
    if (victim.kind === 'secure') victim.session.secureContainer = undefined;
    else victim.session.workContainer = undefined;
  }
}

/**
 * Ensure the Work session has a running command sandbox with `mounts`. Reuses
 * the warm container when alive; recreates it if it died. Throws (fail-closed)
 * if Docker can't start it, so run_command surfaces the error instead of
 * leaking to the host.
 */
async function ensureWorkContainer(session: Session, mounts: WorkMount[], image: string): Promise<string> {
  const existing = session.workContainer;
  if (existing && await isContainerRunning(existing.name)) {
    existing.lastUsed = Date.now();
    existing.inUse = true;
    return existing.name;
  }
  if (existing) {
    stopContainer(existing.name);
    session.workContainer = undefined;
  }
  evictWarmContainersIfNeeded(session);
  const name = await startWorkContainer(mounts, image);
  session.workContainer = { name, lastUsed: Date.now(), inUse: true };
  return name;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/**
 * Abort the in-flight turn for a session WITHOUT tearing the session down
 * (unlike deleteSession, the workspace/container survive). The agent loop stops
 * its model stream and ends cleanly. No-op if nothing is running.
 */
export function abortSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session?.abort) return false;
  session.abort.abort();
  return true;
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session?.secureContainer) stopContainer(session.secureContainer.name);
  if (session?.workContainer) stopContainer(session.workContainer.name);
  if (session?.secureWorkspaceDir) {
    destroySecureWorkspace(session.secureWorkspaceDir);
  }
  if (session?.key) keyToId.delete(session.key);
  sessions.delete(id);
}

/** Get workspace info for a session. */
export function getSessionInfo(id: string): { workspaceSize: number; secure: boolean } | null {
  const session = sessions.get(id);
  if (!session) return null;
  let workspaceSize = 0;
  if (session.secureWorkspaceDir) {
    workspaceSize = getDirSize(session.secureWorkspaceDir);
  }
  return { workspaceSize, secure: session.opts.secure ?? false };
}

/** Export a Safe session's sandbox to a host folder. Null if not a Safe session. */
export function exportSessionWorkspace(id: string, destDir?: string): ExportResult | null {
  const session = sessions.get(id);
  if (!session?.secureWorkspaceDir) return null;
  return exportWorkspace(session.secureWorkspaceDir, destDir);
}

function getDirSize(dir: string): number {
  try {
    let total = 0;
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = `${d}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      }
    };
    walk(dir);
    return total;
  } catch { return 0; }
}

/** Update network setting for a secure session (takes effect on next turn). */
export function setNetworkEnabled(id: string, enabled: boolean): void {
  const session = sessions.get(id);
  if (session) session.opts.networkEnabled = enabled;
}

export function attachSseClient(id: string, res: http.ServerResponse): void {
  const session = sessions.get(id);
  if (!session) return;
  session.sseClient = res;
  for (const event of session.pending) writeSse(res, event);
  session.pending = [];
}

export function detachSseClient(id: string): void {
  const session = sessions.get(id);
  if (session) session.sseClient = null;
}

/** Summarize messages with the cheap model. Best-effort — null on any failure. */
async function summarizeMessages(apiKey: string, msgs: Message[]): Promise<string | null> {
  if (!apiKey || msgs.length === 0) return null;
  const text = msgs
    .map((m) => `${m.role}: ${String(m.content).slice(0, 2000)}`)
    .join('\n\n');
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        stream: false,
        temperature: 0,
        max_tokens: 900,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: `Messages to summarize:\n${text}\n\nReturn the updated summary.` },
        ],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    return j?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Re-compact a long-running session's in-memory history: fold older turns into
 * one summary message, keep the most recent verbatim. Bounds context for
 * sessions that live for hours without a restart. Best-effort — leaves history
 * untouched if summarization fails.
 */
function historyChars(h: Message[]): number {
  let n = 0;
  for (const m of h) {
    n += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
  }
  return n;
}

async function compactHistoryIfNeeded(session: Session): Promise<void> {
  const h = session.history;
  // Trigger on message count OR total size — whichever hits first.
  const over = h.length > HISTORY_COMPACT_TRIGGER || historyChars(h) > HISTORY_COMPACT_CHARS;
  if (!over) return;
  // Need enough older messages to make folding worthwhile.
  if (h.length <= HISTORY_KEEP_RECENT + 1) return;
  const recent = h.slice(-HISTORY_KEEP_RECENT);
  const older = h.slice(0, -HISTORY_KEEP_RECENT);
  const summary = await summarizeMessages(session.opts.apiKey, older);
  if (!summary) return;
  session.history = [
    { role: 'system', content: `Summary of earlier conversation (compacted):\n${summary}` } as Message,
    ...recent,
  ];
}

/**
 * Make dropped files usable by this turn's agent, and describe them to the model.
 *
 *  - Images → base64 data URLs returned in `images`, shown as vision blocks so
 *    the model literally sees them (e.g. a screenshot).
 *  - Other files → made readable, then pointed at by path in `noticeText`:
 *      · Secure: copied into the workspace dir (appears at /workspace/<name>).
 *      · Work/Incognito: the file already lives on the host; we grant the
 *        session read access to its folder and give the model the absolute path.
 *
 * `noticeText` is appended to the user's message so the model KNOWS a file was
 * attached (the bug being fixed: previously the agent had no idea) and how to
 * reach it. Best-effort per file — a failure to stage one is reported inline,
 * never throws.
 */
function stageAttachments(
  session: Session,
  attachments: RuntimeAttachment[] | undefined,
): { noticeText: string; images: string[] } {
  if (!attachments?.length) return { noticeText: '', images: [] };
  const images: string[] = [];
  const lines: string[] = [];

  for (const att of attachments) {
    if (att.mimeType.startsWith('image/')) {
      try {
        const b64 = readFileSync(att.path).toString('base64');
        images.push(`data:${att.mimeType};base64,${b64}`);
        lines.push(`- "${att.fileName}" — image, shown to you directly in this message.`);
        continue;
      } catch {
        // Fall through and treat it as a regular file (path notice only).
      }
    }

    if (session.opts.secure && session.secureWorkspaceDir) {
      const safe = basename(att.fileName) || basename(att.path);
      try {
        copyFileSync(att.path, join(session.secureWorkspaceDir, safe));
        lines.push(`- "${att.fileName}" (${att.mimeType}) — in /workspace; read_file (path "${safe}") only if you need its contents.`);
      } catch (err) {
        lines.push(`- "${att.fileName}" — could not be staged (${err instanceof Error ? err.message : String(err)}).`);
      }
    } else {
      // Work / Incognito read the host filesystem directly. Grant this session
      // read access to the upload's folder so validatePath lets read_file in.
      const dir = dirname(att.path);
      if (!session.opts.allowedFolders.includes(dir)) {
        session.opts.allowedFolders = [...session.opts.allowedFolders, dir];
      }
      lines.push(`- "${att.fileName}" (${att.mimeType}) — available at "${att.path}"; read_file it only if you need its contents.`);
    }
  }

  const noticeText = lines.length
    ? `\n\n[The user attached ${attachments.length} file(s) to THIS message:\n${lines.join('\n')}\nUse them if relevant to the request.]`
    : '';
  return { noticeText, images };
}

export async function sendMessage(sessionId: string, content: string, networkEnabled?: boolean, ttlDays?: number, attachments?: RuntimeAttachment[], copyFolders?: string[]): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Reset TTL countdown on activity
  session.lastActivity = Date.now();
  if (ttlDays !== undefined) session.ttlMs = ttlDays <= 0 ? 0 : ttlDays * 86400_000;

  // Safe Mode: merge in any folders the user added since the session started, so
  // a mid-chat addition gets copied into the sandbox on this turn (not silently
  // dropped). The ingest step below copies only the not-yet-ingested ones.
  if (copyFolders?.length && session.opts.secure) {
    const merged = new Set([...(session.opts.copyFolders ?? []), ...copyFolders]);
    session.opts.copyFolders = [...merged];
  }

  // Per-message network override
  if (networkEnabled !== undefined && session.opts.secure) {
    session.opts.networkEnabled = networkEnabled;
  }

  // Persist the refreshed activity/TTL so it survives a runtime restart.
  persistMeta(session);

  // Keep a long-running session's context bounded (summarize old turns).
  await compactHistoryIfNeeded(session);

  // Fresh abort controller for this turn (user Stop → abortSession()).
  const abort = new AbortController();
  session.abort = abort;

  // Make any dropped files reachable + tell the model about them. `messageText`
  // (content + notice) is what goes to the model AND into history, so follow-up
  // turns remember a file was shared; `images` ride as vision blocks for one turn.
  const { noticeText, images } = stageAttachments(session, attachments);
  const messageText = content + noticeText;

  if (session.opts.secure) {
    const workspaceDir = session.secureWorkspaceDir!;
    const netEnabled = session.opts.networkEnabled ?? false;

    // COPY the user's chosen folders into the isolated workspace — Safe Mode
    // works on a copy, so the originals are never touched. Each folder is copied
    // once (tracked in ingestedFolders), so folders added mid-chat are picked up
    // on the next turn. The summary is prepended so the model knows what's in
    // /workspace and tells the user their files are unchanged.
    let turnText = messageText;
    const ingested = (session.ingestedFolders ??= new Set<string>());
    const pending = (session.opts.copyFolders ?? []).filter((p) => !ingested.has(p));
    if (pending.length) {
      // Mark up front so a failed copy isn't retried every turn.
      for (const p of pending) ingested.add(p);
      const sources: IngestSource[] = pending.map((p) => ({ kind: 'folder', path: p }));
      const results = await ingestSources(workspaceDir, sources);
      for (const r of results) {
        if (!r.ok) emit(session, { type: 'error', message: `Sandbox ingest: ${r.source} — ${r.error}` });
      }
      const summary = describeIngest(results);
      if (summary) turnText = `${summary}\n\n${messageText}`;
    }

    // A Safe turn IS the sandbox, so it needs Docker now — start it ourselves if
    // it's down (it'll auto-stop when idle). Only fail if it's missing/unstartable.
    if (!(await ensureDockerForTask())) {
      emit(session, {
        type: 'error',
        message: 'Safe work needs Docker, which isn’t running and couldn’t be started automatically. Install or start Docker, then try again.',
      });
      return;
    }
    markDockerUse();

    // Warm reuse: get (or lazily start) the session's sandbox container.
    // Fail-closed — if Docker can't start it, surface an error, don't run.
    let containerName: string;
    try {
      containerName = await ensureSecureContainer(session, netEnabled);
    } catch (err) {
      emit(session, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const secureGen = runSecureTurn(
      session.history.map((m) => ({ role: m.role as string, content: String(m.content) })),
      turnText,
      {
        apiKey: session.opts.apiKey,
        model: session.opts.model,
        workspaceDir,
        containerName,
        networkEnabled: netEnabled,
        systemPrompt: session.opts.systemPrompt,
        signal: abort.signal,
        images,
      },
    );
    let assistantText = '';
    // Pin the container so the idle reaper / LRU never frees it mid-turn.
    if (session.secureContainer) session.secureContainer.inUse = true;
    try {
      for await (const event of secureGen) {
        emit(session, event as AgentEvent);
        if (event.type === 'text') assistantText += event.content;
      }
    } finally {
      if (session.secureContainer) {
        session.secureContainer.inUse = false;
        session.secureContainer.lastUsed = Date.now();
      }
      if (session.abort === abort) session.abort = undefined;
    }
    if (assistantText) {
      session.history.push({ role: 'user', content: turnText });
      session.history.push({ role: 'assistant', content: assistantText });
    }
    return;
  }

  // run_command runs in a Docker sandbox with per-folder :ro/:rw mounts so the
  // kernel enforces read-only. Without Docker we leave runShell undefined →
  // run_command is disabled (file tools still work). The container is created
  // lazily on first command, so chat/read-only turns never spin one up.
  //
  // Only EXPLICITLY chosen folders are mounted — never the broad $HOME fallback
  // (mounting all of home would expose ~/.ssh etc. to the shell). Each folder is
  // validated against the secret deny-list and dropped (with a notice) if it
  // names a sensitive root.
  // Incognito forces every mounted folder to :ro — the shell may read but the
  // kernel rejects all writes, matching the read-only contract.
  const incognito = !!session.opts.incognito;
  let runShell: ((command: string, cwd: string) => Promise<string>) | undefined;
  let linkSandbox: ((command: string) => Promise<string>) | undefined;

  // Validate the explicitly-chosen folders into bind mounts (empty when none
  // selected). This is host-only (no Docker needed), so it always runs.
  const validated: { path: string; readonly: boolean }[] = [];
  for (const f of session.opts.folderAccess ?? []) {
    try {
      validated.push({ path: validateMountRoot(f.path), readonly: incognito ? true : f.readonly });
    } catch (err) {
      emit(session, {
        type: 'error',
        message: `Folder excluded from commands: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const mounts: WorkMount[] = toWorkMounts(validated);

  // We DON'T gate on Docker being up. Docker is started lazily inside the tool,
  // the first moment a task actually needs it (ensureDockerForTask) — so pure
  // file-edit / read-only turns never touch Docker, and the user is never nagged
  // to start it up front. If Docker is missing or can't be started, the tool
  // returns a guidance message and file tools still work.
  const ensureSandbox = async (): Promise<boolean> => {
    if (!(await ensureDockerForTask())) return false;
    markDockerUse();
    return true;
  };
  // analyze_link runs yt-dlp inside the session's container (warm-reused, so
  // yt-dlp self-installs once) — never on the host. Offered even with no folders
  // (network-only container). Runs at "/" (it writes to its own scratch paths).
  linkSandbox = async (command) => {
    if (!(await ensureSandbox())) {
      return 'analyze_link needs a Docker sandbox, which isn’t running and couldn’t be started. Use web_fetch/web_search instead.';
    }
    const image = await resolveWorkImage();
    const name = await ensureWorkContainer(session, mounts, image);
    return execInWorkContainer(name, command, '/', { mounts });
  };
  // run_command needs a real folder to operate in, so it stays gated on mounts.
  if (mounts.length) {
    runShell = async (command, cwd) => {
      if (!(await ensureSandbox())) {
        return 'run_command needs a Docker sandbox. Docker isn’t running and couldn’t be started automatically — start (or install) Docker and try again. File read/write tools still work without it.';
      }
      const image = await resolveWorkImage();
      const name = await ensureWorkContainer(session, mounts, image);
      // scan: report created/modified/deleted files after the command so the
      // user sees exactly what changed inside their allowed folders.
      return execInWorkContainer(name, command, cwd, { mounts, scan: true });
    };
  }

  const gen = runAgentTurn(session.history, messageText, {
    apiKey: session.opts.apiKey,
    model: session.opts.model,
    allowedFolders: session.opts.allowedFolders,
    folderAccess: session.opts.folderAccess,
    runShell,
    linkSandbox,
    incognito,
    chatOnly: session.opts.chatOnly,
    characterTools: session.opts.characterTools,
    systemPrompt: session.opts.systemPrompt,
    signal: abort.signal,
    images,
    onWriteApproval: async (filePath, fileContent) => {
      emit(session, { type: 'approval_request', changeId: randomUUID(), path: filePath, content: fileContent });
      return true;
    },
  });

  let assistantText = '';
  try {
    for await (const event of gen) {
      emit(session, event);
      if (event.type === 'text') assistantText += event.content;
    }
  } finally {
    // Release the warm container so the idle reaper / LRU can free it.
    if (session.workContainer) {
      session.workContainer.inUse = false;
      session.workContainer.lastUsed = Date.now();
    }
    if (session.abort === abort) session.abort = undefined;
  }

  if (assistantText) {
    session.history.push({ role: 'user', content: messageText });
    session.history.push({ role: 'assistant', content: assistantText });
  }
}

function emit(session: Session, event: AgentEvent): void {
  if (session.sseClient && !session.sseClient.writableEnded) {
    writeSse(session.sseClient, event);
  } else {
    session.pending.push(event);
  }
}

function writeSse(res: http.ServerResponse, event: AgentEvent): void {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}
