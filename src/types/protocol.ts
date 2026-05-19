/**
 * Wire protocol between the browser client and the iClaw server. One persistent
 * WebSocket per browser tab; all real-time chat traffic flows through it.
 *
 * Form-style HTTP routes still exist for one-shot mutations (rename / agent /
 * delete / project CRUD). They return 302 redirects like normal HTML forms,
 * and the server broadcasts the resulting `chat-updated` / `project-*` events
 * over WS so other tabs see the change instantly. A chat's project is fixed at
 * creation (WebSocket `send` without `chatId`).
 */

import type { Message, Project, ProjectFact, ScheduledMessage } from './index';

/* ---------------- Client → Server ---------------- */

export type ClientMsg =
  /** Begin receiving events for this chat (idempotent). */
  | { type: 'subscribe'; chatId: number }
  /** Stop receiving events for this chat. */
  | { type: 'unsubscribe'; chatId: number }
  /**
   * Send a user message. If chatId is omitted the server creates a new chat
   * first and replies with `chat-created`, then the streaming events.
   *
   * `projectId` is honored only when creating (no chatId). For an existing chat
   * the server ignores this field and uses the chat's stored project.
   */
  | {
      type: 'send';
      requestId: string;
      chatId?: number;
      content: string;
      agent?: string;
      projectId?: number | null;
      /** Reply to an existing user/assistant row in this chat (quote ≤240 chars). */
      replyTo?: { messageId: number; quote: string; role?: string };
      /**
       * Optional inline attachments. Each `content` is base64 (with or without
       * `data:<mime>;base64,` prefix). Server validates size + count, writes
       * the bytes under `data/uploads/<chatId>/...`, and forwards the original
       * base64 to OpenClaw's `chat.send` so the model receives the file too.
       */
      attachments?: Array<{
        mimeType: string;
        fileName: string;
        content: string;
      }>;
      /**
       * Inline secrets: message `content` contains `[[iclaw:sN]]` markers; this array
       * carries plaintext per slot. Server persists rows in `project_secrets` and
       * replaces markers with `[[iclaw:secret:id|encodedLabel]]`. Only for chats
       * that belong to a project.
       */
      inlineSecrets?: Array<{ slot: number; label: string; plain: string }>;
    }
  /** Abort a running turn for this chat. */
  | { type: 'abort'; chatId: number }
  /** Resolve a pending exec approval — `decision` is 'approved' | 'denied'. */
  | {
      type: 'exec-approval';
      chatId: number;
      approvalId: string;
      decision: 'approved' | 'denied';
      reason?: string;
    }
  /** Keepalive — server replies with `pong`. */
  | { type: 'ping' };

/* ---------------- Server → Client ---------------- */

export interface ChatActivitySnapshot {
  state: 'thinking' | 'tool' | 'lifecycle' | 'generating' | 'idle';
  label?: string;
  toolName?: string;
}

export type ServerMsg =
  | { type: 'hello'; serverStarted: number }
  | { type: 'pong' }

  /* ---- chat lifecycle ---- */
  | {
      type: 'chat-created';
      chatId: number;
      title: string;
      agent: string;
      projectId: number | null;
      projectName?: string | null;
      /** SQLite `updated_at` after create — sidebar sorts the flat list. */
      updatedAt: string;
    }
  | {
      type: 'chat-updated';
      chatId: number;
      title?: string;
      agent?: string;
      /** Reassignment to a different project (or null to detach). */
      projectId?: number | null;
      /** Present when `projectId` is set — helps the sidebar render without a reload. */
      projectName?: string | null;
      /** Toggle on whether the chat writes facts back to the project. */
      sharesToProject?: boolean;
      /** Reasoning visibility mode mirror — 'off' | 'on' | 'stream'. */
      reasoningMode?: 'off' | 'on' | 'stream';
      /** Present after mutations that bump `chats.updated_at` — flat sidebar order. */
      updatedAt?: string;
    }
  | { type: 'chat-unread'; chatId: number }
  | { type: 'chat-read'; chatId: number }
  | { type: 'chat-deleted'; chatId: number }

  /* ---- messages + turn streaming ---- */
  | { type: 'message-appended'; chatId: number; message: Message }
  | { type: 'message-updated'; chatId: number; message: Message }
  | {
      type: 'turn-started';
      chatId: number;
      runId: string;
      activity?: ChatActivitySnapshot;
    }
  | { type: 'turn-delta'; chatId: number; text: string }
  | {
      type: 'turn-tool';
      chatId: number;
      phase: 'start' | 'end';
      name: string;
      label: string;
      detail?: string;
    }
  | { type: 'turn-lifecycle'; chatId: number; phase: string; label: string }
  | {
      type: 'turn-attachment';
      chatId: number;
      url: string;
      mime: string;
      label?: string;
    }
  | { type: 'turn-ended'; chatId: number; title: string }
  | { type: 'turn-error'; chatId: number; requestId?: string; error: string }

  /* ---- projects ---- */
  | { type: 'project-created'; project: Project }
  | { type: 'project-updated'; project: Project }
  | { type: 'project-deleted'; projectId: number }
  | { type: 'project-fact-added'; projectId: number; fact: ProjectFact }
  | { type: 'project-fact-updated'; projectId: number; fact: ProjectFact }
  | { type: 'project-fact-deleted'; projectId: number; factId: number }
  | {
      type: 'project-secret-added';
      projectId: number | null;
      secret: { id: number; label: string; created_at: string; value_length: number };
    }
  /** Full list replacement after compaction — clients should replace the facts UI wholesale. */
  | { type: 'project-facts-synced'; projectId: number; facts: ProjectFact[] }
  /**
   * After a turn, proposed lines the user can add to project facts (confirm in chat).
   */
  | {
      type: 'project-fact-suggestions';
      chatId: number;
      projectId: number;
      projectName: string;
      suggestions: { id: number; content: string }[];
    }
  | { type: 'project-fact-suggestion-removed'; chatId: number; suggestionId: number }

  /* ---- scheduled messages (Telegram-style send-later) ---- */
  | { type: 'scheduled-added'; chatId: number; scheduled: ScheduledMessage }
  | { type: 'scheduled-updated'; chatId: number; scheduled: ScheduledMessage }
  | { type: 'scheduled-deleted'; chatId: number; scheduledId: number }

  /* ---- gateway events forwarded to UI ---- */
  /** Gateway session index/metadata changed (possibly from another tab/CLI). */
  | {
      type: 'gateway-session-changed';
      kind: string;
      sessionKey: string | null;
    }
  /** Agent is asking for human approval to run a shell command. */
  | {
      type: 'exec-approval-requested';
      chatId: number;
      approvalId: string;
      command: string;
      cwd: string | null;
      reason: string | null;
      host: string;
    }
  /** Approval resolved (by us, another client, or auto-policy). */
  | {
      type: 'exec-approval-resolved';
      chatId: number;
      approvalId: string;
      decision: string;
    }
  /** A turn lost a reasoning/analysis chunk — only emitted when reasoning is on. */
  | { type: 'turn-reasoning'; chatId: number; text: string }

  /** Live mirror of the OpenClaw gateway health — drives the header badge. */
  | {
      type: 'gateway-status';
      status: 'ok' | 'degraded' | 'shutdown' | 'down';
      detail: string | null;
    };
