import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { deriveTitle } from './chatTitle';
import type { Chat, Message, Project, ProjectFact, ProjectFactSuggestion } from '../types';
import { clampLogoColor, clampLogoEmoji } from '../constants/projectLogos';

// ---------- chats ----------

export const chats = {
  list(): Chat[] {
    return db
      .prepare('SELECT * FROM chats ORDER BY updated_at DESC, id DESC')
      .all() as Chat[];
  },
  get(id: number): Chat | undefined {
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Chat | undefined;
  },
  /** Chats that don't belong to any project. */
  listOrphans(): Chat[] {
    return db
      .prepare(
        'SELECT * FROM chats WHERE project_id IS NULL ORDER BY updated_at DESC, id DESC',
      )
      .all() as Chat[];
  },
  listByProject(projectId: number): Chat[] {
    return db
      .prepare(
        'SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
      )
      .all(projectId) as Chat[];
  },
  create(agent: string, projectId: number | null = null): Chat {
    const sessionKey = randomUUID();
    const info = db
      .prepare(
        'INSERT INTO chats (agent, openclaw_session_id, project_id) VALUES (?, ?, ?)',
      )
      .run(agent, sessionKey, projectId);
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
    db.prepare("UPDATE chats SET agent = ?, updated_at = datetime('now') WHERE id = ?").run(
      agent,
      id,
    );
  },
  setProject(id: number, projectId: number | null): void {
    db.prepare(
      "UPDATE chats SET project_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(projectId, id);
  },
  setSharesToProject(id: number, shares: boolean): void {
    db.prepare(
      "UPDATE chats SET shares_to_project = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(shares ? 1 : 0, id);
  },
  touch(id: number): void {
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(id);
  },
  markRead(id: number): boolean {
    const info = db
      .prepare('UPDATE chats SET unread = 0 WHERE id = ? AND unread != 0')
      .run(id);
    return info.changes > 0;
  },
  markUnread(id: number): boolean {
    const info = db
      .prepare('UPDATE chats SET unread = 1 WHERE id = ? AND unread = 0')
      .run(id);
    return info.changes > 0;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
};

// ---------- messages ----------

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

// ---------- projects ----------

export const projects = {
  list(): Project[] {
    return db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC')
      .all() as Project[];
  },
  get(id: number): Project | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  },
  create(name: string, description?: string | null): Project {
    const info = db
      .prepare(
        'INSERT INTO projects (name, description, logo_preset, logo_emoji, logo_color) VALUES (?, ?, 0, 0, 0)',
      )
      .run(name.trim() || 'Untitled', description ?? null);
    return this.get(Number(info.lastInsertRowid))!;
  },
  setLogoAppearance(id: number, opts: { emoji?: unknown; color?: unknown }): void {
    const cur = this.get(id);
    if (!cur) return;
    const prevE = clampLogoEmoji((cur as unknown as { logo_emoji?: unknown }).logo_emoji ?? 0);
    const prevC = clampLogoColor((cur as unknown as { logo_color?: unknown }).logo_color ?? 0);
    const ei =
      opts.emoji !== undefined && opts.emoji !== null ? clampLogoEmoji(opts.emoji) : prevE;
    const ci =
      opts.color !== undefined && opts.color !== null ? clampLogoColor(opts.color) : prevC;
    db.prepare(
      "UPDATE projects SET logo_emoji = ?, logo_color = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(ei, ci, id);
  },
  rename(id: number, name: string): void {
    db.prepare(
      "UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(name.trim() || 'Untitled', id);
  },
  setDescription(id: number, description: string | null): void {
    db.prepare(
      "UPDATE projects SET description = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(description, id);
  },
  remove(id: number): void {
    // chats keep existing (project_id becomes NULL via FK ON DELETE SET NULL)
    // facts are cascaded.
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  touch(id: number): void {
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
  },
};

// ---------- project facts ----------

const FACTS_DEFAULT_LIMIT = 200;

export const projectFacts = {
  listByProject(projectId: number, limit = FACTS_DEFAULT_LIMIT): ProjectFact[] {
    return db
      .prepare(
        'SELECT * FROM project_facts WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      )
      .all(projectId, limit) as ProjectFact[];
  },
  countByProject(projectId: number): number {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM project_facts WHERE project_id = ?')
      .get(projectId) as { n: number };
    return row.n;
  },
  get(id: number): ProjectFact | undefined {
    return db.prepare('SELECT * FROM project_facts WHERE id = ?').get(id) as
      | ProjectFact
      | undefined;
  },
  append(opts: {
    projectId: number;
    content: string;
    sourceChatId?: number | null;
    sourceMessageId?: number | null;
  }): ProjectFact {
    const trimmed = opts.content.trim();
    if (!trimmed) throw new Error('fact content required');
    const info = db
      .prepare(
        `INSERT INTO project_facts (project_id, content, source_chat_id, source_message_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        opts.projectId,
        trimmed,
        opts.sourceChatId ?? null,
        opts.sourceMessageId ?? null,
      );
    projects.touch(opts.projectId);
    return this.get(Number(info.lastInsertRowid))!;
  },
  edit(id: number, content: string): void {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('fact content required');
    db.prepare(
      "UPDATE project_facts SET content = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(trimmed, id);
    // bump owning project's updated_at
    const row = db
      .prepare('SELECT project_id FROM project_facts WHERE id = ?')
      .get(id) as { project_id: number } | undefined;
    if (row) projects.touch(row.project_id);
  },
  remove(id: number): void {
    const row = db
      .prepare('SELECT project_id FROM project_facts WHERE id = ?')
      .get(id) as { project_id: number } | undefined;
    db.prepare('DELETE FROM project_facts WHERE id = ?').run(id);
    if (row) projects.touch(row.project_id);
  },
  /**
   * Atomic replace — used by compaction. Drops all facts for the project and
   * inserts the new list. Caller is responsible for content quality.
   */
  replaceAll(projectId: number, newContents: string[]): void {
    const trx = db.transaction((items: string[]) => {
      db.prepare('DELETE FROM project_facts WHERE project_id = ?').run(projectId);
      const insert = db.prepare(
        'INSERT INTO project_facts (project_id, content) VALUES (?, ?)',
      );
      for (const c of items) {
        const t = c.trim();
        if (t) insert.run(projectId, t);
      }
      db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(
        projectId,
      );
    });
    trx(newContents);
  },
};

// ---------- project fact suggestions (user confirm in chat) ----------

export const projectFactSuggestions = {
  listByChat(chatId: number): ProjectFactSuggestion[] {
    return db
      .prepare(
        'SELECT * FROM project_fact_suggestions WHERE chat_id = ? ORDER BY id ASC',
      )
      .all(chatId) as ProjectFactSuggestion[];
  },
  get(id: number): ProjectFactSuggestion | undefined {
    return db.prepare('SELECT * FROM project_fact_suggestions WHERE id = ?').get(id) as
      | ProjectFactSuggestion
      | undefined;
  },
  insert(opts: {
    projectId: number;
    chatId: number;
    content: string;
    assistantMessageId: number | null;
  }): ProjectFactSuggestion {
    const trimmed = opts.content.trim();
    if (!trimmed) throw new Error('suggestion content required');
    const info = db
      .prepare(
        `INSERT INTO project_fact_suggestions (project_id, chat_id, content, assistant_message_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(opts.projectId, opts.chatId, trimmed, opts.assistantMessageId ?? null);
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM project_fact_suggestions WHERE id = ?').run(id);
  },
};

// ---------- search ----------

const SEARCH_MAX_LEN = 200;

export const chatSearch = {
  matchingChatIds(query: string): number[] {
    let needle = query.trim().toLowerCase();
    if (!needle) return [];
    if (needle.length > SEARCH_MAX_LEN) needle = needle.slice(0, SEARCH_MAX_LEN);
    const rows = db
      .prepare(
        `SELECT DISTINCT c.id AS id
         FROM chats c
         LEFT JOIN messages m ON m.chat_id = c.id
         WHERE instr(lower(c.title), ?) > 0
            OR instr(lower(COALESCE(m.content, '')), ?) > 0
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 500`,
      )
      .all(needle, needle) as { id: number }[];
    return rows.map((r) => r.id);
  },
};
