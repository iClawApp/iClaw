/**
 * In-memory Work Mode session manager.
 * Each session holds conversation history and streams events via SSE.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { runAgentTurn, type Message } from './agent/loop.js';
import type { AgentEvent } from './agent/loop.js';
import { runSecureTurn } from './secure-runner.js';

export interface SessionOptions {
  allowedFolders: string[];
  model: string;
  apiKey: string;
  secure?: boolean;
}

interface Session {
  id: string;
  opts: SessionOptions;
  history: Message[];
  sseClient: http.ServerResponse | null;
  pending: AgentEvent[];
}

const sessions = new Map<string, Session>();

export function createSession(opts: SessionOptions): string {
  const id = randomUUID();
  sessions.set(id, { id, opts, history: [], sseClient: null, pending: [] });
  return id;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

/** Register SSE client and flush any pending events. */
export function attachSseClient(id: string, res: http.ServerResponse): void {
  const session = sessions.get(id);
  if (!session) return;
  session.sseClient = res;
  for (const event of session.pending) {
    writeSse(res, event);
  }
  session.pending = [];
}

export function detachSseClient(id: string): void {
  const session = sessions.get(id);
  if (session) session.sseClient = null;
}

/** Send message and run the agent turn. */
export async function sendMessage(sessionId: string, content: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Secure mode: run in Docker container
  if (session.opts.secure) {
    const secureGen = runSecureTurn(
      session.history.map((m) => ({ role: m.role as string, content: String(m.content) })),
      content,
      { apiKey: session.opts.apiKey, model: session.opts.model },
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

  // Run the agent turn and emit events
  const gen = runAgentTurn(session.history, content, {
    apiKey: session.opts.apiKey,
    model: session.opts.model,
    allowedFolders: session.opts.allowedFolders,
    onWriteApproval: async (filePath, fileContent) => {
      // TODO: wire up approval UI — auto-approve for now
      emit(session, { type: 'approval_request', changeId: randomUUID(), path: filePath, content: fileContent });
      return true;
    },
  });

  let assistantText = '';
  for await (const event of gen) {
    emit(session, event);
    if (event.type === 'text') assistantText += event.content;
  }

  // Persist turn in history
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
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // client gone
  }
}
