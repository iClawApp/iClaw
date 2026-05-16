/**
 * Browser WebSocket endpoint. Mounted at /ws via the http.Server upgrade
 * handler in app.ts. Receives ClientMsg, dispatches to chatRunner /
 * openclawWs / chatStatus, and pushes ServerMsg events back through wsHub.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { wsHub } from '../services/wsHub';
import { sendMessage, abortChatRun } from '../services/chatRunner';
import type { ClientMsg, ServerMsg } from '../types/protocol';

const PATH = '/ws';

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
    case 'subscribe':
      if (typeof msg.chatId === 'number') wsHub.subscribe(socket, msg.chatId);
      return;

    case 'unsubscribe':
      if (typeof msg.chatId === 'number') wsHub.unsubscribe(socket, msg.chatId);
      return;

    case 'ping':
      send(socket, { type: 'pong' });
      return;

    case 'send': {
      const content = String(msg.content ?? '').trim();
      if (!content) {
        send(socket, {
          type: 'turn-error',
          chatId: msg.chatId ?? 0,
          requestId: msg.requestId,
          error: 'content required',
        });
        return;
      }
      try {
        // chatRunner subscribes `socket` to the chat synchronously before
        // emitting any events, so we receive the entire turn here.
        await sendMessage({
          chatId: msg.chatId,
          content,
          agentLabel: msg.agent,
          requestId: msg.requestId,
          subscriber: socket,
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
