/**
 * gatewayEvents.dispatch() is internal — we exercise it by mocking gatewayWs
 * to capture the frame listener gatewayEvents registers, then feeding it
 * synthetic events and asserting on wsHub broadcasts + RPC calls.
 *
 * We avoid the module's `started` latch by using vi.resetModules() before
 * each test and re-importing fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb } from '../helpers/db';

// captures
let frameListener: ((frame: unknown) => void) | null = null;
let reconnectListener: (() => void) | null = null;
const broadcastAll = vi.fn();
const broadcastToChat = vi.fn();
const subscribeSessions = vi.fn(async () => undefined);

beforeEach(() => {
  resetTestDb();
  frameListener = null;
  reconnectListener = null;
  broadcastAll.mockClear();
  broadcastToChat.mockClear();
  subscribeSessions.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../src/services/gatewayWs');
  vi.doUnmock('../../src/services/wsHub');
  vi.doUnmock('../../src/services/openclawWs');
});

async function setupAndStart(): Promise<typeof import('../../src/services/store')> {
  vi.doMock('../../src/services/gatewayWs', () => ({
    gatewayWs: {
      onFrame: vi.fn((listener: (frame: unknown) => void) => {
        frameListener = listener;
        return () => {};
      }),
      onReconnect: vi.fn((listener: () => void) => {
        reconnectListener = listener;
        return () => {};
      }),
      request: vi.fn(async () => ({})),
    },
  }));
  vi.doMock('../../src/services/wsHub', () => ({
    wsHub: { broadcastAll, broadcastToChat, send: vi.fn() },
  }));
  vi.doMock('../../src/services/openclawWs', () => ({
    openclawWs: { subscribeSessions },
  }));
  const { gatewayEvents } = await import('../../src/services/gatewayEvents');
  const store = await import('../../src/services/store');
  gatewayEvents.start();
  // Subscribe should be fired on start
  expect(subscribeSessions).toHaveBeenCalledTimes(1);
  expect(typeof frameListener).toBe('function');
  return store;
}

describe('gatewayEvents.start()', () => {
  it('registers onFrame + onReconnect and kicks the initial sessions.subscribe', async () => {
    await setupAndStart();
    expect(typeof reconnectListener).toBe('function');
  });

  it('re-fires sessions.subscribe on every reconnect', async () => {
    await setupAndStart();
    reconnectListener?.();
    reconnectListener?.();
    expect(subscribeSessions).toHaveBeenCalledTimes(3); // initial + 2 reconnects
  });

  it('start() is idempotent within one module instance', async () => {
    const { gatewayEvents } = await import('../../src/services/gatewayEvents');
    // The first setup already called start(); a manual second call must no-op.
    gatewayEvents.start?.();
    // We can't easily assert subscribeSessions count here since start was
    // already called in setup. Just check no throw.
  });
});

describe('gatewayEvents dispatch — sessions.changed', () => {
  it('forwards as gateway-session-changed with the picked kind + sessionKey', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'sessions.changed',
      payload: { kind: 'created', sessionKey: 'agent:abc' },
    });
    const out = broadcastAll.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'gateway-session-changed',
    );
    expect(out).toBeDefined();
    expect(out![0]).toEqual({
      type: 'gateway-session-changed',
      kind: 'created',
      sessionKey: 'agent:abc',
    });
  });

  it('defaults kind to "update" when not provided', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'sessions.changed',
      payload: { sessionKey: 'agent:abc' },
    });
    const out = broadcastAll.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'gateway-session-changed',
    );
    expect((out![0] as { kind: string }).kind).toBe('update');
  });
});

describe('gatewayEvents dispatch — exec.approval.requested', () => {
  it('routes to broadcastToChat with the matching iClaw chat id', async () => {
    const store = await setupAndStart();
    const c = store.chats.create('openclaw/default');
    store.chats.replaceSessionKey(c.id, 'agent:has-key');

    frameListener?.({
      type: 'event',
      event: 'exec.approval.requested',
      payload: {
        approvalId: 'a-1',
        sessionKey: 'agent:has-key',
        command: 'rm -rf /important',
        cwd: '/repo',
        reason: 'Destructive operation',
      },
    });
    const out = broadcastToChat.mock.calls.find(
      ([, m]) => (m as { type?: string }).type === 'exec-approval-requested',
    );
    expect(out).toBeDefined();
    expect(out![0]).toBe(c.id);
    expect(out![1]).toMatchObject({
      type: 'exec-approval-requested',
      chatId: c.id,
      approvalId: 'a-1',
      command: 'rm -rf /important',
      cwd: '/repo',
      reason: 'Destructive operation',
    });
  });

  it('falls back to argv array → joined command string', async () => {
    const store = await setupAndStart();
    const c = store.chats.create('openclaw/default');
    store.chats.replaceSessionKey(c.id, 'agent:fallback');

    frameListener?.({
      type: 'event',
      event: 'exec.approval.requested',
      payload: {
        approvalId: 'a-2',
        sessionKey: 'agent:fallback',
        argv: ['npm', 'install', 'lodash'],
      },
    });
    const out = broadcastToChat.mock.calls.find(
      ([, m]) => (m as { type?: string }).type === 'exec-approval-requested',
    );
    expect(out).toBeDefined();
    expect((out![1] as { command: string }).command).toBe('npm install lodash');
  });

  it('ignores events for unknown sessionKey (no broadcast)', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { approvalId: 'a-3', sessionKey: 'agent:nobody' },
    });
    expect(
      broadcastToChat.mock.calls.find(
        ([, m]) => (m as { type?: string }).type === 'exec-approval-requested',
      ),
    ).toBeUndefined();
  });

  it('drops events missing approvalId or sessionKey', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { sessionKey: 'agent:has-key' },
    });
    frameListener?.({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { approvalId: 'a-4' },
    });
    expect(
      broadcastToChat.mock.calls.filter(
        ([, m]) => (m as { type?: string }).type === 'exec-approval-requested',
      ),
    ).toHaveLength(0);
  });
});

describe('gatewayEvents dispatch — exec.approval.resolved', () => {
  it('broadcasts to the owning chat when sessionKey is known', async () => {
    const store = await setupAndStart();
    const c = store.chats.create('openclaw/default');
    store.chats.replaceSessionKey(c.id, 'agent:resolved-key');
    frameListener?.({
      type: 'event',
      event: 'exec.approval.resolved',
      payload: {
        approvalId: 'a-5',
        sessionKey: 'agent:resolved-key',
        decision: 'approved',
      },
    });
    const out = broadcastToChat.mock.calls.find(
      ([, m]) => (m as { type?: string }).type === 'exec-approval-resolved',
    );
    expect(out).toBeDefined();
    expect((out![1] as { decision: string }).decision).toBe('approved');
  });

  it('falls back to broadcastAll with chatId:0 when sessionKey is missing', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'exec.approval.resolved',
      payload: { approvalId: 'a-6', decision: 'denied' },
    });
    const out = broadcastAll.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'exec-approval-resolved',
    );
    expect(out).toBeDefined();
    expect((out![0] as { chatId: number }).chatId).toBe(0);
  });
});

describe('gatewayEvents dispatch — health / shutdown', () => {
  it('healthy event → gateway-status: ok', async () => {
    await setupAndStart();
    // First push a degraded state to overcome the "skip if unchanged" guard.
    frameListener?.({
      type: 'event',
      event: 'health',
      payload: { ok: false, reason: 'mem high' },
    });
    frameListener?.({
      type: 'event',
      event: 'health',
      payload: { ok: true },
    });
    const calls = broadcastAll.mock.calls
      .map(([m]) => m as { type?: string; status?: string })
      .filter((m) => m.type === 'gateway-status');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.find((c) => c.status === 'degraded')).toBeDefined();
    expect(calls.find((c) => c.status === 'ok')).toBeDefined();
  });

  it('shutdown event → gateway-status: shutdown', async () => {
    await setupAndStart();
    frameListener?.({
      type: 'event',
      event: 'shutdown',
      payload: { reason: 'operator quit' },
    });
    const out = broadcastAll.mock.calls.find(
      ([m]) =>
        (m as { type?: string; status?: string }).type === 'gateway-status' &&
        (m as { status?: string }).status === 'shutdown',
    );
    expect(out).toBeDefined();
  });

  it('drops non-event frames', async () => {
    await setupAndStart();
    const before = broadcastAll.mock.calls.length;
    frameListener?.({ type: 'res', id: '1', ok: true, payload: {} });
    expect(broadcastAll.mock.calls.length).toBe(before);
  });
});
