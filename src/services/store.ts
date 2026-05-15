import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { deriveTitle } from './chatTitle';
import type { Chat, Message } from '../types';

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
  rename(id: number, title: string, opts?: { manual?: boolean }): void {
    const next = title.trim() || 'New chat';
    if (opts?.manual) {
      db.prepare(
        "UPDATE chats SET title = ?, title_manual = 1, updated_at = datetime('now') WHERE id = ?",
      ).run(next, id);
    } else {
      db.prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
        next,
        id,
      );
    }
  },
  trySetAutoTitle(id: number, title: string): boolean {
    const next = title.trim() || 'New chat';
    const info = db
      .prepare(
        "UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ? AND title_manual = 0",
      )
      .run(next, id);
    return info.changes > 0;
  },
  isTitleManual(id: number): boolean {
    const row = db.prepare('SELECT title_manual FROM chats WHERE id = ?').get(id) as
      | { title_manual: number }
      | undefined;
    return Boolean(row?.title_manual);
  },
  replaceSessionKey(id: number, sessionKey: string): void {
    db.prepare(
      "UPDATE chats SET openclaw_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(sessionKey, id);
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
