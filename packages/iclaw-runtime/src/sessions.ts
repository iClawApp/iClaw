/**
 * In-memory session manager for Work and Secure modes.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';

import { runAgentTurn, type Message } from './agent/loop.js';
import type { AgentEvent } from './agent/loop.js';
import {
  runSecureTurn, createSecureWorkspace, destroySecureWorkspace,
  startContainer, stopContainer, isContainerRunning,
  writeSessionMeta, listPersistedWorkspaces,
} from './secure-runner.js';

export interface SessionOptions {
  allowedFolders: string[];
  model: string;
  apiKey: string;
  secure?: boolean;
  networkEnabled?: boolean;
  systemPrompt?: string;
  /** Stable identity (e.g. "chat:156") for reconnecting to a workspace. */
  key?: string;
  /**
   * Optional compacted prior history (from the host's DB) used to seed context
   * after a restart. Only applied when the session has no history yet — never
   * clobbers a live session's accumulated context.
   */
  history?: { role: string; content: string }[];
}

interface Session {
  id: string;
  opts: SessionOptions;
  history: Message[];
  sseClient: http.ServerResponse | null;
  pending: AgentEvent[];
  /** Persistent workspace dir for Secure Mode (survives container restarts). */
  secureWorkspaceDir?: string;
  /**
   * Warm Secure-Mode sandbox container, reused across turns. Recreated only
   * when the network setting changes or after the container is reaped for idle;
   * the workspace dir outlives it either way.
   */
  secureContainer?: { name: string; networkEnabled: boolean; lastUsed: number; inUse: boolean };
  /** Stable identity for reconnection across restarts. */
  key?: string;
  /** Last activity timestamp (ms). Updated on each message. */
  lastActivity: number;
  /** TTL in ms after last activity before cleanup. 0 = never. Default 7 days. */
  ttlMs: number;
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
const SUMMARY_MODEL = process.env.ICLAW_SUMMARY_MODEL || 'google/gemini-2.5-flash-lite';
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

/** LRU-evict warm containers (excluding `keep`) until under the cap. */
function evictWarmContainersIfNeeded(keep: Session): void {
  // Never evict a container mid-turn.
  const warm = [...sessions.values()].filter((s) => s !== keep && s.secureContainer && !s.secureContainer.inUse);
  while (warm.length >= MAX_WARM_CONTAINERS) {
    warm.sort((a, b) => (a.secureContainer!.lastUsed) - (b.secureContainer!.lastUsed));
    const victim = warm.shift();
    if (!victim?.secureContainer) break;
    stopContainer(victim.secureContainer.name);
    victim.secureContainer = undefined;
  }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session?.secureContainer) stopContainer(session.secureContainer.name);
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
async function compactHistoryIfNeeded(session: Session): Promise<void> {
  if (session.history.length <= HISTORY_COMPACT_TRIGGER) return;
  const recent = session.history.slice(-HISTORY_KEEP_RECENT);
  const older = session.history.slice(0, -HISTORY_KEEP_RECENT);
  const summary = await summarizeMessages(session.opts.apiKey, older);
  if (!summary) return;
  session.history = [
    { role: 'system', content: `Summary of earlier conversation (compacted):\n${summary}` } as Message,
    ...recent,
  ];
}

export async function sendMessage(sessionId: string, content: string, networkEnabled?: boolean, ttlDays?: number): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Reset TTL countdown on activity
  session.lastActivity = Date.now();
  if (ttlDays !== undefined) session.ttlMs = ttlDays <= 0 ? 0 : ttlDays * 86400_000;

  // Per-message network override
  if (networkEnabled !== undefined && session.opts.secure) {
    session.opts.networkEnabled = networkEnabled;
  }

  // Persist the refreshed activity/TTL so it survives a runtime restart.
  persistMeta(session);

  // Keep a long-running session's context bounded (summarize old turns).
  await compactHistoryIfNeeded(session);

  if (session.opts.secure) {
    const workspaceDir = session.secureWorkspaceDir!;
    const netEnabled = session.opts.networkEnabled ?? false;

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
      content,
      {
        apiKey: session.opts.apiKey,
        model: session.opts.model,
        workspaceDir,
        containerName,
        networkEnabled: netEnabled,
        systemPrompt: session.opts.systemPrompt,
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
    }
    if (assistantText) {
      session.history.push({ role: 'user', content });
      session.history.push({ role: 'assistant', content: assistantText });
    }
    return;
  }

  const gen = runAgentTurn(session.history, content, {
    apiKey: session.opts.apiKey,
    model: session.opts.model,
    allowedFolders: session.opts.allowedFolders,
    systemPrompt: session.opts.systemPrompt,
    onWriteApproval: async (filePath, fileContent) => {
      emit(session, { type: 'approval_request', changeId: randomUUID(), path: filePath, content: fileContent });
      return true;
    },
  });

  let assistantText = '';
  for await (const event of gen) {
    emit(session, event);
    if (event.type === 'text') assistantText += event.content;
  }

  if (assistantText) {
    session.history.push({ role: 'user', content });
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
