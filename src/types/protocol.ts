/**
 * Wire protocol between the browser client and the iClaw server. One persistent
 * WebSocket per browser tab; all real-time chat traffic flows through it.
 *
 * Form-style HTTP routes still exist for one-shot mutations (rename / agent /
 * delete) — those return 302 redirects like normal HTML forms, and the server
 * broadcasts the resulting `chat-updated` event over WS so other tabs see the
 * change instantly.
 */

import type { Message } from './index';

/* ---------------- Client → Server ---------------- */

export type ClientMsg =
  /** Begin receiving events for this chat (idempotent). */
  | { type: 'subscribe'; chatId: number }
  /** Stop receiving events for this chat. */
  | { type: 'unsubscribe'; chatId: number }
  /**
   * Send a user message. If chatId is omitted the server creates a new chat
   * first and replies with `chat-created`, then the streaming events.
   */
  | {
      type: 'send';
      requestId: string; // client-generated; echoed in turn-error so client can pair errors
      chatId?: number;
      content: string;
      agent?: string;
    }
  /** Abort a running turn for this chat. */
  | { type: 'abort'; chatId: number }
  /** Keepalive — server replies with `pong`. */
  | { type: 'ping' };

/* ---------------- Server → Client ---------------- */

/** Snapshot of in-flight activity for a chat (used when a client (re)subscribes). */
export interface ChatActivitySnapshot {
  state: 'thinking' | 'tool' | 'lifecycle' | 'generating' | 'idle';
  label?: string;
  toolName?: string;
}

export type ServerMsg =
  /** Hello after connect — includes pid so the client can detect a server restart. */
  | { type: 'hello'; serverStarted: number }
  /** Ack for client ping. */
  | { type: 'pong' }

  /** Chat row was created (e.g. by a `send` without chatId). */
  | { type: 'chat-created'; chatId: number; title: string; agent: string }
  /** Chat metadata changed (title, agent). */
  | { type: 'chat-updated'; chatId: number; title?: string; agent?: string }
  /** Assistant reply finished while no tab was viewing this chat. */
  | { type: 'chat-unread'; chatId: number }
  /** User opened this chat — clear sidebar unread indicator. */
  | { type: 'chat-read'; chatId: number }
  /** Chat was deleted; clients on that chat should navigate away. */
  | { type: 'chat-deleted'; chatId: number }

  /** Persisted message landed in the DB (both roles). */
  | { type: 'message-appended'; chatId: number; message: Message }

  /** A new turn just began (sent right after subscribe if a turn was already in flight). */
  | { type: 'turn-started'; chatId: number; runId: string; activity?: ChatActivitySnapshot }
  /** Streaming text delta for a turn. */
  | { type: 'turn-delta'; chatId: number; text: string }
  /** Tool invocation lifecycle. */
  | {
      type: 'turn-tool';
      chatId: number;
      phase: 'start' | 'end';
      name: string;
      label: string;
      /** Human description of what the tool is doing right now (e.g. "ls -la /tmp"). */
      detail?: string;
    }
  /** Coarse turn lifecycle (start/end/etc.). */
  | { type: 'turn-lifecycle'; chatId: number; phase: string; label: string }
  /** Inline attachment for the running turn (image / video / file). */
  | {
      type: 'turn-attachment';
      chatId: number;
      url: string;
      mime: string;
      label?: string;
    }
  /** Turn finished cleanly. Final assistant message is also delivered via `message-appended`. */
  | { type: 'turn-ended'; chatId: number; title: string }
  /** Turn failed. */
  | { type: 'turn-error'; chatId: number; requestId?: string; error: string };
