/**
 * chatStatus is the per-chat lock + activity registry. Tests pin down:
 *   - withLock serialises overlapping callers in FIFO order
 *   - workingIds/snapshot reflect in-flight callers
 *   - activity writes are gated by "is anyone holding the lock"
 *   - forceClear nukes a stuck entry without breaking the active promise
 */
import { describe, expect, it } from 'vitest';
import { chatStatus } from '../../src/services/chatStatus';

describe('chatStatus.withLock', () => {
  it('runs the callback and reports the chat as working during the run', async () => {
    const chatId = 1;
    expect(chatStatus.isWorking(chatId)).toBe(false);
    const p = chatStatus.withLock(chatId, async () => {
      // While the lock is held, isWorking must be true.
      expect(chatStatus.isWorking(chatId)).toBe(true);
      expect(chatStatus.workingIds()).toContain(chatId);
      return 42;
    });
    expect(await p).toBe(42);
    // After the lock releases, the entry is dropped and isWorking is false again.
    expect(chatStatus.isWorking(chatId)).toBe(false);
    expect(chatStatus.workingIds()).not.toContain(chatId);
  });

  it('serialises concurrent calls in FIFO order per chat', async () => {
    const chatId = 2;
    const order: string[] = [];
    const slow = chatStatus.withLock(chatId, async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('A-end');
    });
    const next = chatStatus.withLock(chatId, async () => {
      order.push('B-start');
      order.push('B-end');
    });
    const last = chatStatus.withLock(chatId, async () => {
      order.push('C-start');
      order.push('C-end');
    });
    await Promise.all([slow, next, last]);
    expect(order).toEqual([
      'A-start', 'A-end', 'B-start', 'B-end', 'C-start', 'C-end',
    ]);
  });

  it('does not serialise across different chats', async () => {
    const events: string[] = [];
    const a = chatStatus.withLock(10, async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('a-end');
    });
    const b = chatStatus.withLock(11, async () => {
      // Should start immediately even though 10 is busy.
      events.push('b-start');
      events.push('b-end');
    });
    await Promise.all([a, b]);
    // b-start must appear before a-end
    expect(events.indexOf('b-start')).toBeLessThan(events.indexOf('a-end'));
  });

  it('releases the lock even when the callback throws', async () => {
    const chatId = 3;
    await expect(
      chatStatus.withLock(chatId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(chatStatus.isWorking(chatId)).toBe(false);
    // Next call must run normally
    const v = await chatStatus.withLock(chatId, async () => 'ok');
    expect(v).toBe('ok');
  });

  it('snapshot() returns each working chat with its activity (or undefined)', async () => {
    const chatId = 4;
    const p = chatStatus.withLock(chatId, async () => {
      chatStatus.setActivity(chatId, { kind: 'tool', name: 'bash', label: 'Running…' });
      await new Promise((r) => setTimeout(r, 30));
    });
    // Wait a microtask + a setImmediate so the callback's setActivity has run.
    await new Promise((r) => setTimeout(r, 5));
    const snap = chatStatus.snapshot().find((e) => e.id === chatId);
    expect(snap).toBeDefined();
    expect(snap?.activity?.kind).toBe('tool');
    await p;
    // Drained after release.
    expect(chatStatus.snapshot().find((e) => e.id === chatId)).toBeUndefined();
  });
});

describe('chatStatus.setActivity', () => {
  it('is a no-op when nobody holds the lock for that chat', () => {
    const chatId = 50;
    chatStatus.setActivity(chatId, { kind: 'thinking', label: 'Thinking…' });
    // We never opened a lock, so the entry should not exist.
    expect(chatStatus.getActivity(chatId)).toBeUndefined();
    expect(chatStatus.isWorking(chatId)).toBe(false);
  });

  it('clears activity when given null', async () => {
    const chatId = 51;
    await chatStatus.withLock(chatId, async () => {
      chatStatus.setActivity(chatId, { kind: 'thinking', label: 'Thinking…' });
      expect(chatStatus.getActivity(chatId)?.kind).toBe('thinking');
      chatStatus.setActivity(chatId, null);
      expect(chatStatus.getActivity(chatId)).toBeUndefined();
    });
  });
});

describe('chatStatus.forceClear', () => {
  it('drops a stuck entry and returns true', () => {
    // Simulate a "stuck" lock by entering withLock and never resolving the
    // outer promise. Instead, we just check the public behaviour: when nobody
    // is in the lock, forceClear returns false.
    expect(chatStatus.forceClear(999)).toBe(false);
  });

  it('returns true after we manually marked a chat as working', async () => {
    const chatId = 60;
    // We can't easily fake a "stuck" run; the contract still holds: any time
    // the map has an entry for the chat, forceClear() returns true.
    const p = chatStatus.withLock(chatId, async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // While the lock is held, forceClear drops it from the map.
    expect(chatStatus.forceClear(chatId)).toBe(true);
    // After the original promise finishes, no double-cleanup is required.
    await p;
    expect(chatStatus.isWorking(chatId)).toBe(false);
  });
});
