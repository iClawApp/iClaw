import { describe, expect, it } from 'vitest';
import { chats, queuedMessages } from '../../src/services/store';

describe('store.queuedMessages', () => {
  it('create() + listByChat() preserves order by position', () => {
    const c = chats.create('openclaw/default');
    const a = queuedMessages.create({ chatId: c.id, content: 'first' });
    const b = queuedMessages.create({ chatId: c.id, content: 'second' });
    expect(queuedMessages.listByChat(c.id).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('rejects empty content without attachments', () => {
    const c = chats.create('openclaw/default');
    expect(() => queuedMessages.create({ chatId: c.id, content: '   ' })).toThrow(
      /content or attachments/,
    );
  });

  it('promoteToFront() moves a row ahead of others', () => {
    const c = chats.create('openclaw/default');
    queuedMessages.create({ chatId: c.id, content: 'A' });
    const b = queuedMessages.create({ chatId: c.id, content: 'B' });
    queuedMessages.promoteToFront(c.id, b.id);
    expect(queuedMessages.listByChat(c.id).map((r) => r.content)).toEqual(['B', 'A']);
  });

  it('remove() deletes the row', () => {
    const c = chats.create('openclaw/default');
    const row = queuedMessages.create({ chatId: c.id, content: 'x' });
    queuedMessages.remove(row.id);
    expect(queuedMessages.get(row.id)).toBeUndefined();
  });

  it('chat delete cascades to queued_messages', () => {
    const c = chats.create('openclaw/default');
    const row = queuedMessages.create({ chatId: c.id, content: 'q' });
    chats.remove(c.id);
    expect(queuedMessages.listByChat(c.id)).toEqual([]);
    expect(queuedMessages.get(row.id)).toBeUndefined();
  });
});
