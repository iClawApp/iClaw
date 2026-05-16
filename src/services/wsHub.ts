/**
 * In-memory pub/sub hub for browser WebSocket clients.
 *
 * Each socket has a Set of subscribed chatIds. The server pushes events
 * scoped to a chat (`broadcastToChat`) or globally (`broadcastAll`). This
 * is how cross-tab sync works — when chat 5 receives a streaming delta we
 * push to every socket that has 5 in its subscribed set.
 */

import type { WebSocket } from 'ws';
import type { ServerMsg } from '../types/protocol';

interface Subscription {
  socket: WebSocket;
  chats: Set<number>;
}

class WsHub {
  private readonly subs = new Map<WebSocket, Subscription>();
  /** Server start time — included in hello so clients can detect restarts. */
  readonly serverStarted = Date.now();

  register(socket: WebSocket): void {
    this.subs.set(socket, { socket, chats: new Set() });
    socket.on('close', () => this.subs.delete(socket));
    socket.on('error', () => this.subs.delete(socket));
  }

  subscribe(socket: WebSocket, chatId: number): void {
    this.subs.get(socket)?.chats.add(chatId);
  }

  unsubscribe(socket: WebSocket, chatId: number): void {
    this.subs.get(socket)?.chats.delete(chatId);
  }

  /** Send a single message to one socket. */
  send(socket: WebSocket, msg: ServerMsg): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[wsHub] send failed', err);
    }
  }

  /** Push to every socket subscribed to this chat. */
  broadcastToChat(chatId: number, msg: ServerMsg): void {
    for (const sub of this.subs.values()) {
      if (sub.chats.has(chatId)) this.send(sub.socket, msg);
    }
  }

  /** Push to every connected socket (used for chat-created / chat-deleted index events). */
  broadcastAll(msg: ServerMsg): void {
    for (const sub of this.subs.values()) {
      this.send(sub.socket, msg);
    }
  }

  /** Stats for debugging. */
  count(): { clients: number; subscriptions: number } {
    let subscriptions = 0;
    for (const sub of this.subs.values()) subscriptions += sub.chats.size;
    return { clients: this.subs.size, subscriptions };
  }
}

export const wsHub = new WsHub();
