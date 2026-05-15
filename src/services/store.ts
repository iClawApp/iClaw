import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import type { Chat, Message } from '../types';

const TITLE_LIMIT = 60;

function deriveTitle(firstMessage: string): string {
  const single = firstMessage.replace(/\s+/g, ' ').trim();
  if (!single) return 'New chat';
  return single.length > TITLE_LIMIT ? single.slice(0, TITLE_LIMIT - 1) + '…' : single;
}

export const chats = {
  list(): Chat[] {
    return db
      .prepare('SELECT * FROM chats ORDER BY updated_at DESC, id DESC')
      .all() as Chat[];
  },
  get(id: number): Chat | undefined {
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Chat | undefined;
  },
  create(agent: string): Chat {
    const sessionKey = randomUUID();
    const info = db
      .prepare('INSERT INTO chats (agent, openclaw_session_id) VALUES (?, ?)')
      .run(agent, sessionKey);
    return this.get(Number(info.lastInsertRowid))!;
  },
  rename(id: number, title: string): void {
    db.prepare('UPDATE chats SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      title.trim() || 'New chat',
      id,
    );
  },
  setAgent(id: number, agent: string): void {
    db.prepare('UPDATE chats SET agent = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      agent,
      id,
    );
  },
  touch(id: number): void {
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(id);
  },
  remove(id: number): void {
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
};

export const messages = {
  listByChat(chatId: number): Message[] {
    return db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC')
      .all(chatId) as Message[];
  },
  append(
    chatId: number,
    role: string,
    content: string,
    finishReason: string | null = null,
  ): Message {
    const info = db
      .prepare(
        'INSERT INTO messages (chat_id, role, content, finish_reason) VALUES (?, ?, ?, ?)',
      )
      .run(chatId, role, content, finishReason);
    chats.touch(chatId);
    // Auto-name a chat from its first user message
    if (role === 'user') {
      const count = (db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'user'")
        .get(chatId) as { n: number }).n;
      if (count === 1) {
        const current = chats.get(chatId);
        if (current && (current.title === 'New chat' || current.title === '')) {
          db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(
            deriveTitle(content),
            chatId,
          );
        }
      }
    }
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as Message;
  },
};
