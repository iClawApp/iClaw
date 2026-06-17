import { afterEach, describe, expect, it } from 'vitest';
import { db, resetTestDb } from '../helpers/db';
import { chats, scheduledMessages } from '../../src/services/store';

afterEach(() => resetTestDb());

describe('store.scheduledMessages', () => {
  it('create() normalises Date / ISO string to SQLite UTC stamp', () => {
    const c = chats.create('openclaw/default');
    const at = new Date('2026-05-17T15:30:00Z');
    const row = scheduledMessages.create({ chatId: c.id, content: 'later', scheduledAt: at });
    expect(row.content).toBe('later');
    // 'YYYY-MM-DD HH:MM:SS' format
    expect(row.scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.scheduled_at).toBe('2026-05-17 15:30:00');

    const row2 = scheduledMessages.create({
      chatId: c.id,
      content: 'also later',
      scheduledAt: '2026-12-31T23:59:00Z',
    });
    expect(row2.scheduled_at).toBe('2026-12-31 23:59:00');
  });

  it('create() persists mode and round-trips it; defaults to null', () => {
    const c = chats.create('openclaw/default');
    const work = scheduledMessages.create({
      chatId: c.id,
      content: '[Auto-resume] keep polling the job',
      scheduledAt: '2026-06-01T10:00:00Z',
      mode: 'work',
    });
    expect(work.mode).toBe('work');
    // survives a fresh read (column is selected back, not just echoed)
    expect(scheduledMessages.get(work.id)?.mode).toBe('work');

    const plain = scheduledMessages.create({
      chatId: c.id,
      content: 'no mode given',
      scheduledAt: '2026-06-01T10:00:00Z',
    });
    expect(plain.mode).toBeNull();
  });

  it('create() rejects empty content and invalid datetime', () => {
    const c = chats.create('openclaw/default');
    expect(() =>
      scheduledMessages.create({ chatId: c.id, content: '   ', scheduledAt: new Date() }),
    ).toThrow(/required/);
    expect(() =>
      scheduledMessages.create({
        chatId: c.id,
        content: 'ok',
        scheduledAt: 'definitely-not-a-date',
      }),
    ).toThrow(/invalid/);
  });

  it('listByChat() returns rows in scheduled_at ascending order', () => {
    const c = chats.create('openclaw/default');
    scheduledMessages.create({
      chatId: c.id,
      content: 'C',
      scheduledAt: '2026-06-01T10:00:00Z',
    });
    scheduledMessages.create({
      chatId: c.id,
      content: 'A',
      scheduledAt: '2026-05-20T10:00:00Z',
    });
    scheduledMessages.create({
      chatId: c.id,
      content: 'B',
      scheduledAt: '2026-05-25T10:00:00Z',
    });
    expect(scheduledMessages.listByChat(c.id).map((r) => r.content)).toEqual(['A', 'B', 'C']);
  });

  it('listDue() picks up rows in the past, ignores future rows', () => {
    const c = chats.create('openclaw/default');
    const pastA = scheduledMessages.create({
      chatId: c.id,
      content: 'past A',
      scheduledAt: '2020-01-01T00:00:00Z',
    });
    const pastB = scheduledMessages.create({
      chatId: c.id,
      content: 'past B',
      scheduledAt: '2020-01-02T00:00:00Z',
    });
    scheduledMessages.create({
      chatId: c.id,
      content: 'future',
      scheduledAt: '2099-01-01T00:00:00Z',
    });
    const due = scheduledMessages.listDue();
    const ids = due.map((r) => r.id);
    expect(ids).toContain(pastA.id);
    expect(ids).toContain(pastB.id);
    expect(due.find((r) => r.content === 'future')).toBeUndefined();
  });

  it('update() changes content and scheduled_at', () => {
    const c = chats.create('openclaw/default');
    const r = scheduledMessages.create({
      chatId: c.id,
      content: 'before',
      scheduledAt: '2026-06-01T10:00:00Z',
    });
    const updated = scheduledMessages.update(r.id, {
      content: 'after',
      scheduledAt: '2026-06-02T12:30:00Z',
    });
    expect(updated?.content).toBe('after');
    expect(updated?.scheduled_at).toBe('2026-06-02 12:30:00');
  });

  it('remove() drops one row by id', () => {
    const c = chats.create('openclaw/default');
    const r = scheduledMessages.create({
      chatId: c.id,
      content: 'gone',
      scheduledAt: new Date(),
    });
    scheduledMessages.remove(r.id);
    expect(scheduledMessages.get(r.id)).toBeUndefined();
  });

  it('chat delete cascades to scheduled_messages', () => {
    const c = chats.create('openclaw/default');
    scheduledMessages.create({
      chatId: c.id,
      content: 'will be cascaded',
      scheduledAt: new Date(),
    });
    chats.remove(c.id);
    expect(scheduledMessages.listByChat(c.id)).toEqual([]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get() as { n: number }).n,
    ).toBe(0);
  });
});
