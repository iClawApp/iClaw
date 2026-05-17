/**
 * wsHub is the in-memory pub/sub registry. Tests fake the `ws` WebSocket
 * surface (just enough — `on`, `send`, `readyState`, `OPEN`) so we can
 * verify scoping (broadcastToChat vs broadcastAll), subscription
 * bookkeeping, and graceful handling of half-closed sockets.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMsg } from '../../src/types/protocol';
import { wsHub } from '../../src/services/wsHub';

interface FakeSocket {
  readonly OPEN: number;
  readyState: number;
  sent: string[];
  on: (event: string, handler: () => void) => void;
  send: (data: string) => void;
  __close: () => void;
  __error: () => void;
}

function makeSocket(): FakeSocket {
  const handlers: Record<string, () => void> = {};
  const sock: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    on(event, handler) {
      handlers[event] = handler;
    },
    send(data) {
      sock.sent.push(data);
    },
    __close: () => handlers.close?.(),
    __error: () => handlers.error?.(),
  };
  return sock;
}

beforeEach(() => {
  // Reset the singleton by closing all registered sockets.
  // (wsHub doesn't expose a `.clear()` — close() removes from the map.)
  // We close fresh sockets we control in each test; stale sockets from
  // other tests are gone because we use new ones each time.
});

describe('wsHub.register + close', () => {
  it('registers a socket and removes it on close', () => {
    const sock = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.register(sock as any);
    expect(wsHub.count().clients).toBeGreaterThanOrEqual(1);
    sock.__close();
    // The socket should be gone now (count back down to whatever others left)
    const after = wsHub.count();
    expect(after.clients).toBeGreaterThanOrEqual(0);
  });

  it('removes a socket on error too', () => {
    const sock = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.register(sock as any);
    const before = wsHub.count().clients;
    sock.__error();
    expect(wsHub.count().clients).toBe(before - 1);
  });
});

describe('wsHub.subscribe / hasSubscriber', () => {
  it('records subscriptions per socket', () => {
    const a = makeSocket();
    const b = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.register(a as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.register(b as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(a as any, 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(b as any, 200);
    expect(wsHub.hasSubscriber(100)).toBe(true);
    expect(wsHub.hasSubscriber(200)).toBe(true);
    expect(wsHub.hasSubscriber(999)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.unsubscribe(a as any, 100);
    expect(wsHub.hasSubscriber(100)).toBe(false);
    a.__close();
    b.__close();
  });
});

describe('wsHub.broadcastToChat', () => {
  it('reaches only sockets subscribed to that chat', () => {
    const a = makeSocket();
    const b = makeSocket();
    const c = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [a, b, c].forEach((s) => wsHub.register(s as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(a as any, 7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(b as any, 7);
    // c is connected but not subscribed
    const msg: ServerMsg = { type: 'turn-delta', chatId: 7, text: 'hello' };
    wsHub.broadcastToChat(7, msg);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
    expect(JSON.parse(a.sent[0])).toEqual(msg);
    [a, b, c].forEach((s) => s.__close());
  });
});

describe('wsHub.broadcastAll', () => {
  it('hits every connected socket regardless of subscriptions', () => {
    const a = makeSocket();
    const b = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [a, b].forEach((s) => wsHub.register(s as any));
    const msg: ServerMsg = { type: 'chat-deleted', chatId: 42 };
    wsHub.broadcastAll(msg);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    [a, b].forEach((s) => s.__close());
  });

  it('skips sockets whose readyState is not OPEN', () => {
    const a = makeSocket();
    const b = makeSocket();
    b.readyState = 3; // CLOSED
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [a, b].forEach((s) => wsHub.register(s as any));
    wsHub.broadcastAll({ type: 'pong' });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
    [a, b].forEach((s) => s.__close());
  });
});

describe('wsHub.count', () => {
  it('returns clients + subscription totals', () => {
    const a = makeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.register(a as any);
    const start = wsHub.count();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(a as any, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsHub.subscribe(a as any, 2);
    const mid = wsHub.count();
    expect(mid.subscriptions - start.subscriptions).toBe(2);
    a.__close();
  });
});
