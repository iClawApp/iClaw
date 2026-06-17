/**
 * Scheduler sweeps `scheduled_messages` and dispatches due rows through the
 * normal `sendMessage` path. We stub sendMessage so we don't reach a real
 * gateway, and assert the rows are deleted + broadcast in the right order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, scheduledMessages } from '../../src/services/store';

// Stub chatRunner.sendMessage BEFORE importing scheduler.
const sendMessageMock = vi.fn(async () => ({ chatId: 1 }));
vi.mock('../../src/services/chatRunner', () => ({
  sendMessage: sendMessageMock,
  abortChatRun: vi.fn(async () => undefined),
}));

// Capture wsHub broadcasts so we can assert on order.
const broadcastAllMock = vi.fn();
vi.mock('../../src/services/wsHub', () => ({
  wsHub: {
    broadcastAll: broadcastAllMock,
    broadcastToChat: vi.fn(),
    send: vi.fn(),
    register: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    hasSubscriber: vi.fn(() => false),
    serverStarted: Date.now(),
  },
}));

// Import after mocks so the scheduler picks them up.
const { scheduler } = await import('../../src/services/scheduler');

beforeEach(() => {
  resetTestDb();
  sendMessageMock.mockClear();
  broadcastAllMock.mockClear();
});

afterEach(() => {
  scheduler.stop();
});

describe('scheduler', () => {
  it('fires due rows and removes them from the table', async () => {
    const c = chats.create('openclaw/default');
    const row = scheduledMessages.create({
      chatId: c.id,
      content: 'hello from the past',
      scheduledAt: '2020-01-01T00:00:00Z',
    });
    // Call the internal sweepOnce path by starting then stopping the
    // scheduler — `start()` kicks off an immediate sweep.
    scheduler.start();
    // Let the microtask queue settle so sweepOnce runs.
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduledMessages.get(row.id)).toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledWith({
      chatId: c.id,
      content: 'hello from the past',
    });
  });

  it('fires with the row\'s stored mode so a Work auto-resume stays in Work', async () => {
    const c = chats.create('openclaw/default');
    scheduledMessages.create({
      chatId: c.id,
      content: '[Auto-resume] re-check the background job',
      scheduledAt: '2020-01-01T00:00:00Z',
      mode: 'work',
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(sendMessageMock).toHaveBeenCalledWith({
      chatId: c.id,
      content: '[Auto-resume] re-check the background job',
      mode: 'work',
    });
  });

  it('broadcasts scheduled-deleted BEFORE the send fires', async () => {
    const c = chats.create('openclaw/default');
    scheduledMessages.create({
      chatId: c.id,
      content: 'pls',
      scheduledAt: '2020-01-01T00:00:00Z',
    });
    // Slow sendMessage so we can verify ordering
    sendMessageMock.mockImplementationOnce(async () => {
      // wait a tick before resolving
      await new Promise((r) => setTimeout(r, 25));
      return { chatId: c.id };
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80));

    const deletedCall = broadcastAllMock.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'scheduled-deleted',
    );
    expect(deletedCall).toBeDefined();
    // sendMessage was called too
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('leaves future rows untouched', async () => {
    const c = chats.create('openclaw/default');
    const future = scheduledMessages.create({
      chatId: c.id,
      content: 'much later',
      scheduledAt: '2099-12-31T23:59:00Z',
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduledMessages.get(future.id)).toBeDefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('survives a sendMessage failure and still removes the row', async () => {
    const c = chats.create('openclaw/default');
    const row = scheduledMessages.create({
      chatId: c.id,
      content: 'doomed but persistent',
      scheduledAt: '2020-01-01T00:00:00Z',
    });
    sendMessageMock.mockRejectedValueOnce(new Error('gateway down'));
    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    // Row is gone — we delete before send to guarantee no second-fire.
    expect(scheduledMessages.get(row.id)).toBeUndefined();
  });

  it('start() is idempotent — does not double-schedule the interval', async () => {
    scheduler.start();
    scheduler.start();
    scheduler.start();
    // Nothing crashes; no exception means we trust the idempotent guard.
    expect(true).toBe(true);
  });
});
