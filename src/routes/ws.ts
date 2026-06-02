/**
 * Browser WebSocket endpoint. Mounted at /ws via the http.Server upgrade
 * handler in app.ts. Receives ClientMsg, dispatches to chatRunner /
 * openclawWs / chatStatus, and pushes ServerMsg events back through wsHub.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { chats } from '../services/store';
import { wsHub } from '../services/wsHub';
import { sendMessage, abortChatRun, type WorkFolder } from '../services/chatRunner';
import { openclawWs } from '../services/openclawWs';
import type { ClientMsg, ServerMsg } from '../types/protocol';
import type { InlineSecretWire } from '../services/inlineSecrets';
import { normalizeChatMode } from '../services/chatModes';

const PATH = '/ws';

/**
 * Coerce the untrusted `workFolders` wire field into typed WorkFolder[]. Accepts
 * either objects ({ path, readonly }) from the current client or bare path
 * strings from older clients. Missing/unknown readonly defaults to true
 * (read-only) — the safe default. Returns undefined when nothing valid is sent.
 */
function parseWorkFolders(raw: unknown): WorkFolder[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WorkFolder[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry) out.push({ path: entry, readonly: true });
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      if (typeof o.path === 'string' && o.path) {
        out.push({ path: o.path, readonly: o.readonly !== false });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function send(socket: WebSocket, msg: ServerMsg): void {
  wsHub.send(socket, msg);
}

function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw) as Partial<ClientMsg> & { type?: string };
    if (!obj || typeof obj.type !== 'string') return null;
    return obj as ClientMsg;
  } catch {
    return null;
  }
}

async function handleClientMsg(socket: WebSocket, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case 'subscribe': {
      const chatId = msg.chatId;
      if (typeof chatId !== 'number') return;
      wsHub.subscribe(socket, chatId);
      if (chats.markRead(chatId)) wsHub.broadcastAll({ type: 'chat-read', chatId });
      return;
    }

    case 'unsubscribe':
      if (typeof msg.chatId === 'number') wsHub.unsubscribe(socket, msg.chatId);
      return;

    case 'ping':
      send(socket, { type: 'pong' });
      return;

    case 'send': {
      const content = String(msg.content ?? '').trim();
      const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
      if (!content && !hasAttachments) {
        send(socket, {
          type: 'turn-error',
          chatId: msg.chatId ?? 0,
          requestId: msg.requestId,
          error: 'content or attachments required',
        });
        return;
      }
      try {
        let inlineSecrets: InlineSecretWire[] | undefined;
        if (Array.isArray((msg as { inlineSecrets?: unknown }).inlineSecrets)) {
          const raw = (msg as { inlineSecrets: unknown[] }).inlineSecrets;
          inlineSecrets = raw
            .map((x): InlineSecretWire | null => {
              if (!x || typeof x !== 'object') return null;
              const o = x as Record<string, unknown>;
              const slot = Number(o.slot);
              if (!Number.isFinite(slot)) return null;
              return {
                slot,
                label: String(o.label ?? ''),
                plain: String(o.plain ?? ''),
              };
            })
            .filter((x): x is InlineSecretWire => x != null);
        }
        // chatRunner subscribes `socket` to the chat synchronously before
        // emitting any events, so we receive the entire turn here.
        await sendMessage({
          chatId: msg.chatId,
          content,
          agentLabel: msg.agent,
          projectId: msg.chatId == null ? (msg.projectId ?? null) : undefined,
          requestId: msg.requestId,
          subscriber: socket,
          replyTo: msg.replyTo,
          incomingAttachments: msg.attachments,
          inlineSecrets,
          mode: normalizeChatMode((msg as { mode?: unknown }).mode),
          networkEnabled: (msg as Record<string, unknown>).networkEnabled === true,
          ttlDays: typeof (msg as Record<string, unknown>).ttlDays === 'number'
            ? ((msg as Record<string, unknown>).ttlDays as number)
            : undefined,
          workFolders: parseWorkFolders((msg as Record<string, unknown>).workFolders),
        });
      } catch (err) {
        // Errors are already broadcast via chatRunner; nothing more to do.
        console.error('[ws] send failed', err);
      }
      return;
    }

    case 'abort':
      if (typeof msg.chatId === 'number') {
        await abortChatRun(msg.chatId).catch((err) => {
          console.error('[ws] abort failed', err);
        });
      }
      return;

    case 'exec-approval': {
      const approvalId = String(msg.approvalId ?? '').trim();
      const decision = msg.decision === 'denied' ? 'denied' : 'approved';
      if (!approvalId) return;
      try {
        await openclawWs.resolveExecApproval({
          approvalId,
          decision,
          reason: msg.reason,
        });
        // The gateway broadcasts `exec.approval.resolved` after we resolve, so
        // the UI card-removal flows through the same path as external resolves.
      } catch (err) {
        console.error('[ws] exec.approval.resolve failed', err);
      }
      return;
    }
  }
}

export function attachWsServer(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, sock, head) => {
    if (req.url !== PATH) {
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    wsHub.register(socket);
    send(socket, { type: 'hello', serverStarted: wsHub.serverStarted });

    socket.on('message', (data) => {
      const msg = parseClientMsg(data.toString());
      if (!msg) return;
      handleClientMsg(socket, msg).catch((err) => {
        console.error('[ws] handler threw', err);
      });
    });
  });
}
