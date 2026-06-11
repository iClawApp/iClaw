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
  /**
   * Whether this tab is actively viewing — window focused AND visible. Flipped
   * false on blur/hide so a turn that finishes while the user has stepped away
   * marks the chat UNREAD (blue dot) instead of read. Defaults true.
   */
  active: boolean;
}

class WsHub {
  private readonly subs = new Map<WebSocket, Subscription>();
  /** Server start time — included in hello so clients can detect restarts. */
  readonly serverStarted = Date.now();

  register(socket: WebSocket): void {
    this.subs.set(socket, { socket, chats: new Set(), active: true });
    socket.on('close', () => this.subs.delete(socket));
    socket.on('error', () => this.subs.delete(socket));
  }

  // A tab views exactly one chat at a time, so subscribing REPLACES the prior
  // chat. The client never sends `unsubscribe`, so without this the set would
  // accumulate and hasActiveSubscriber would treat stale chats as still-viewed.
  subscribe(socket: WebSocket, chatId: number): void {
    const sub = this.subs.get(socket);
    if (!sub) return;
    sub.chats.clear();
    sub.chats.add(chatId);
  }

  /** Mark whether a socket is actively viewing (window focused + visible). */
  setActive(socket: WebSocket, active: boolean): void {
    const sub = this.subs.get(socket);
    if (sub) sub.active = active;
  }

  /** Chats a socket is subscribed to (0 or 1 in practice). */
  subscribedChats(socket: WebSocket): number[] {
    return [...(this.subs.get(socket)?.chats ?? [])];
  }

  /**
   * True when a tab is subscribed to this chat AND actively viewing it. This —
   * not hasSubscriber — drives read/unread: a chat that finishes while nobody is
   * actively looking becomes unread.
   */
  hasActiveSubscriber(chatId: number): boolean {
    for (const sub of this.subs.values()) {
      if (sub.active && sub.chats.has(chatId)) return true;
    }
    return false;
  }

  unsubscribe(socket: WebSocket, chatId: number): void {
    this.subs.get(socket)?.chats.delete(chatId);
  }

  /** True when at least one connected tab is subscribed to this chat. */
  hasSubscriber(chatId: number): boolean {
    for (const sub of this.subs.values()) {
      if (sub.chats.has(chatId)) return true;
    }
    return false;
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
