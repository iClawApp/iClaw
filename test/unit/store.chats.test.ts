import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, resetTestDb } from '../helpers/db';
import { chats, messages } from '../../src/services/store';

beforeAll(() => resetTestDb());
afterEach(() => resetTestDb());

describe('store.chats', () => {
  it('create() seeds an agent: session key and stores agent + project', () => {
    const c = chats.create('openclaw/code', null);
    expect(c.id).toBeGreaterThan(0);
    expect(c.agent).toBe('openclaw/code');
    expect(c.project_id).toBeNull();
    // session keys are NOT yet `agent:` — they become so on first ensureSession
    expect(typeof c.openclaw_session_id).toBe('string');
    expect(c.openclaw_session_id.length).toBeGreaterThan(8);
    expect(c.shares_to_project).toBe(1);
  });

  it('list() returns chats newest-updated first', () => {
    const a = chats.create('openclaw/default');
    const b = chats.create('openclaw/default');
    // Bump order via activity, not rename — rename must not move chats in the list.
    messages.append(b.id, 'user', 'newer');
    const list = chats.list();
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it('rename({manual:true}) does not change updated_at (list order unchanged)', () => {
    const a = chats.create('openclaw/default');
    db.prepare("UPDATE chats SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a.id);
    const b = chats.create('openclaw/default');
    messages.append(b.id, 'user', 'keep b on top');
    const orderBefore = chats.list().map((c) => c.id);
    const aRowBefore = chats.get(a.id)!;
    chats.rename(a.id, 'Renamed A', { manual: true });
    expect(chats.list().map((c) => c.id)).toEqual(orderBefore);
    expect(chats.get(a.id)!.updated_at).toBe(aRowBefore.updated_at);
    expect(chats.get(a.id)!.title).toBe('Renamed A');
  });

  it('listOrphans vs listByProject splits chats correctly', () => {
    const orphan = chats.create('openclaw/default', null);
    const proj = db
      .prepare("INSERT INTO projects (name) VALUES ('P') RETURNING id")
      .get() as { id: number };
    const attached = chats.create('openclaw/default', proj.id);
    expect(chats.listOrphans().map((c) => c.id)).toEqual([orphan.id]);
    expect(chats.listByProject(proj.id).map((c) => c.id)).toEqual([attached.id]);
  });

  it('rename({manual:true}) pins title against trySetAutoTitle', () => {
    const c = chats.create('openclaw/default');
    chats.rename(c.id, 'Manual choice', { manual: true });
    expect(chats.isTitleManual(c.id)).toBe(true);
    const changed = chats.trySetAutoTitle(c.id, 'Auto suggestion');
    expect(changed).toBe(false);
    expect(chats.get(c.id)!.title).toBe('Manual choice');
  });

  it('trySetAutoTitle updates when title_manual=0 and returns true', () => {
    const c = chats.create('openclaw/default');
    expect(chats.trySetAutoTitle(c.id, 'Auto title')).toBe(true);
    expect(chats.get(c.id)!.title).toBe('Auto title');
    expect(chats.isTitleManual(c.id)).toBe(false);
  });

  it('findBySessionKey reverse-lookups by openclaw_session_id', () => {
    const c = chats.create('openclaw/default');
    chats.replaceSessionKey(c.id, 'agent:abc123');
    const found = chats.findBySessionKey('agent:abc123');
    expect(found?.id).toBe(c.id);
    expect(chats.findBySessionKey('agent:nope')).toBeUndefined();
    expect(chats.findBySessionKey('')).toBeUndefined();
  });

  it('markUnread/markRead are no-ops when the bit is already correct', () => {
    const c = chats.create('openclaw/default');
    expect(chats.markUnread(c.id)).toBe(true);
    expect(chats.markUnread(c.id)).toBe(false); // already 1
    expect(chats.markRead(c.id)).toBe(true);
    expect(chats.markRead(c.id)).toBe(false); // already 0
  });

  it('forceUnread always sets unread=1', () => {
    const c = chats.create('openclaw/default');
    expect(chats.get(c.id)!.unread).toBe(0);
    expect(chats.forceUnread(c.id)).toBe(true);
    expect(chats.get(c.id)!.unread).toBe(1);
    expect(chats.forceUnread(c.id)).toBe(true);
    expect(chats.get(c.id)!.unread).toBe(1);
  });

  it('forceUnread does not change updated_at (list order unchanged)', () => {
    const a = chats.create('openclaw/default');
    db.prepare("UPDATE chats SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a.id);
    const b = chats.create('openclaw/default');
    const orderBefore = chats.list().map((c) => c.id);
    const bRowBefore = chats.get(b.id)!;
    expect(chats.forceUnread(b.id)).toBe(true);
    expect(chats.list().map((c) => c.id)).toEqual(orderBefore);
    expect(chats.get(b.id)!.updated_at).toBe(bRowBefore.updated_at);
    expect(chats.get(b.id)!.unread).toBe(1);
  });

  it('SQLite trigger bumps chats.updated_at on message insert', () => {
    const c = chats.create('openclaw/default');
    db.prepare("UPDATE chats SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(c.id);
    const stale = chats.get(c.id)!.updated_at;
    expect(stale).toBe('2020-01-01 00:00:00');
    messages.append(c.id, 'user', 'hello');
    const fresh = chats.get(c.id)!.updated_at;
    expect(fresh).not.toBe(stale);
    expect(fresh > stale).toBe(true);
  });
});

describe('store.messages', () => {
  it('append() persists user/assistant rows in order', () => {
    const c = chats.create('openclaw/default');
    const u = messages.append(c.id, 'user', 'hi');
    const a = messages.append(c.id, 'assistant', 'hello back');
    const list = messages.listByChat(c.id);
    expect(list.map((m) => m.id)).toEqual([u.id, a.id]);
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('append() stores reply_to fields for user messages', () => {
    const c = chats.create('openclaw/default');
    const a = messages.append(c.id, 'assistant', 'context line');
    const u = messages.append(c.id, 'user', 'follow up', null, {
      replyToMessageId: a.id,
      replyQuote: 'context line',
      replyToRole: 'assistant',
    });
    const row = messages.get(u.id)!;
    expect(row.reply_to_message_id).toBe(a.id);
    expect(row.reply_quote).toBe('context line');
    expect(row.reply_to_role).toBe('assistant');
  });

  it('first user message derives title when current is "New chat"', () => {
    const c = chats.create('openclaw/default');
    messages.append(c.id, 'user', 'How do I deploy this app to production?');
    const after = chats.get(c.id)!;
    expect(after.title).not.toBe('New chat');
    expect(after.title.length).toBeGreaterThan(0);
  });

  it('first user message does not overwrite a manually-set title', () => {
    const c = chats.create('openclaw/default');
    chats.rename(c.id, 'My custom title', { manual: true });
    messages.append(c.id, 'user', 'A totally different sentence');
    expect(chats.get(c.id)!.title).toBe('My custom title');
  });
});
