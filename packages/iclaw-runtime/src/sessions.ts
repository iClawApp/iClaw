/**
 * In-memory session manager for Work and Secure modes.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';

import { runAgentTurn, type Message } from './agent/loop.js';
import type { AgentEvent } from './agent/loop.js';
import { runSecureTurn, createSecureWorkspace, destroySecureWorkspace } from './secure-runner.js';

export interface SessionOptions {
  allowedFolders: string[];
  model: string;
  apiKey: string;
  secure?: boolean;
  networkEnabled?: boolean;
  systemPrompt?: string;
}

interface Session {
  id: string;
  opts: SessionOptions;
  history: Message[];
  sseClient: http.ServerResponse | null;
  pending: AgentEvent[];
  /** Persistent workspace dir for Secure Mode (survives container restarts). */
  secureWorkspaceDir?: string;
  /** Last activity timestamp (ms). Updated on each message. */
  lastActivity: number;
  /** TTL in ms after last activity before cleanup. 0 = never. Default 7 days. */
  ttlMs: number;
}

const DEFAULT_TTL_MS = 7 * 86400_000;
const sessions = new Map<string, Session>();

export function createSession(opts: SessionOptions): string {
  const id = randomUUID();
  const session: Session = {
    id, opts, history: [], sseClient: null, pending: [],
    lastActivity: Date.now(), ttlMs: DEFAULT_TTL_MS,
  };
  if (opts.secure) {
    session.secureWorkspaceDir = createSecureWorkspace();
  }
  sessions.set(id, session);
  return id;
}

/** Set TTL (days) for a session. 0 = never expire. */
export function setSessionTtl(id: string, ttlDays: number): void {
  const session = sessions.get(id);
  if (session) session.ttlMs = ttlDays <= 0 ? 0 : ttlDays * 86400_000;
}

/** Sweep expired sessions — destroys workspace + frees memory. Runs periodically. */
export function sweepExpiredSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.ttlMs > 0 && now - session.lastActivity > session.ttlMs) {
      if (session.secureWorkspaceDir) destroySecureWorkspace(session.secureWorkspaceDir);
      session.sseClient?.end();
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session?.secureWorkspaceDir) {
    destroySecureWorkspace(session.secureWorkspaceDir);
  }
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

  if (session.opts.secure) {
    const workspaceDir = session.secureWorkspaceDir!;
    const secureGen = runSecureTurn(
      session.history.map((m) => ({ role: m.role as string, content: String(m.content) })),
      content,
      {
        apiKey: session.opts.apiKey,
        model: session.opts.model,
        workspaceDir,
        networkEnabled: session.opts.networkEnabled ?? false,
        systemPrompt: session.opts.systemPrompt,
      },
    );
    let assistantText = '';
    for await (const event of secureGen) {
      emit(session, event as AgentEvent);
      if (event.type === 'text') assistantText += event.content;
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
