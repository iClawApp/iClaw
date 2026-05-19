import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { deriveTitle } from './chatTitle';
import type {
  Chat,
  Message,
  MessageAttachment,
  Project,
  ProjectFact,
  ProjectFactSuggestion,
  ProjectSecret,
  QueuedMessage,
  ScheduledMessage,
} from '../types';
import type { InlineSecretWire } from './inlineSecrets';
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
  /** Reverse lookup — gateway broadcasts events keyed by OpenClaw session key. */
  findBySessionKey(sessionKey: string): Chat | undefined {
    if (!sessionKey) return undefined;
    return db
      .prepare('SELECT * FROM chats WHERE openclaw_session_id = ? LIMIT 1')
      .get(sessionKey) as Chat | undefined;
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
  /** Rename only — does not touch `updated_at` so sidebar order stays put. */
  rename(id: number, title: string, opts?: { manual?: boolean }): void {
    const next = title.trim() || 'New chat';
    if (opts?.manual) {
      db.prepare('UPDATE chats SET title = ?, title_manual = 1 WHERE id = ?').run(next, id);
    } else {
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(next, id);
    }
  },
  trySetAutoTitle(id: number, title: string): boolean {
    const next = title.trim() || 'New chat';
    const info = db
      .prepare('UPDATE chats SET title = ? WHERE id = ? AND title_manual = 0')
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
  setSharesToProject(id: number, shares: boolean): void {
    db.prepare(
      "UPDATE chats SET shares_to_project = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(shares ? 1 : 0, id);
  },
  setReasoningMode(id: number, mode: 'off' | 'on' | 'stream'): void {
    db.prepare(
      "UPDATE chats SET reasoning_mode = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(mode, id);
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
  /** Force unread=1 (Telegram-style "mark unread" from sidebar). Idempotent. Does not touch `updated_at` so the chat stays in place in the sidebar. */
  forceUnread(id: number): boolean {
    if (!this.get(id)) return false;
    db.prepare('UPDATE chats SET unread = 1 WHERE id = ?').run(id);
    return true;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
};

/** UI: attach source chat title from `chats` (not persisted on `project_facts`). */
export function enrichFactWithSourceChatTitle(fact: ProjectFact): ProjectFact {
  const sid = fact.source_chat_id;
  if (sid == null) return { ...fact };
  const c = chats.get(sid);
  const source_chat_title = (c?.title ?? '').trim() || 'Chat';
  return { ...fact, source_chat_title };
}

export function enrichFactsWithSourceChatTitles(facts: ProjectFact[]): ProjectFact[] {
  return facts.map(enrichFactWithSourceChatTitle);
}

// ---------- messages ----------

type MessageRow = Omit<Message, 'attachments'> & { attachments: string | null };

/** Parse the `attachments` TEXT column (JSON string) into the typed array shape. */
function hydrateMessage(row: MessageRow | undefined): Message | undefined {
  if (!row) return undefined;
  let attachments: Message['attachments'] = null;
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      // Corrupt JSON — treat as no attachments rather than crashing the read path.
    }
  }
  return { ...row, attachments };
}

export const messages = {
  listByChat(chatId: number): Message[] {
    const rows = db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC')
      .all(chatId) as MessageRow[];
    return rows.map((r) => hydrateMessage(r) as Message);
  },
  get(id: number): Message | undefined {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return hydrateMessage(row);
  },
  append(
    chatId: number,
    role: string,
    content: string,
    finishReason: string | null = null,
    reply?: { replyToMessageId: number; replyQuote: string; replyToRole: string } | null,
    attachments?: MessageAttachment[] | null,
  ): Message {
    const rid = reply?.replyToMessageId ?? null;
    const rq = reply?.replyQuote ?? null;
    const rrole = reply?.replyToRole ?? null;
    const att =
      attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
    const info = db
      .prepare(
        'INSERT INTO messages (chat_id, role, content, finish_reason, reply_to_message_id, reply_quote, reply_to_role, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(chatId, role, content, finishReason, rid, rq, rrole, att);
    // chats.updated_at is bumped by the trg_chats_touch_on_message SQLite
    // trigger; no manual touch() needed here. We keep chats.touch() public
    // for callers that mutate parents without writing a message (e.g.
    // project deletion detaching chats).
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
    const out = hydrateMessage(
      db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as MessageRow,
    );
    return out as Message;
  },
  updateContent(id: number, content: string): Message | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
    return this.get(id);
  },
};

// ---------- projects ----------

/** Activity in the last 14 days (messages, then distinct chats with messages). */
export type ProjectListMetrics = {
  project: Project;
  chatTotal: number;
  messages14d: number;
  chats14d: number;
};

type ProjectRowWithMetrics = Project & {
  chat_total: number;
  msgs_14: number;
  chats_14: number;
};

function listProjectsWithMetricsRows(): ProjectRowWithMetrics[] {
  return db
    .prepare(
      `SELECT
         p.id,
         p.name,
         p.description,
         p.logo_emoji,
         p.logo_color,
         p.created_at,
         p.updated_at,
         (SELECT COUNT(*) FROM chats c WHERE c.project_id = p.id) AS chat_total,
         (SELECT COUNT(*) FROM messages m
            INNER JOIN chats c ON c.id = m.chat_id
            WHERE c.project_id = p.id
              AND datetime(m.created_at) >= datetime('now', '-14 days')) AS msgs_14,
         (SELECT COUNT(DISTINCT m.chat_id) FROM messages m
            INNER JOIN chats c ON c.id = m.chat_id
            WHERE c.project_id = p.id
              AND datetime(m.created_at) >= datetime('now', '-14 days')) AS chats_14
       FROM projects p
       ORDER BY msgs_14 DESC, chats_14 DESC, unicode_lower(p.name) ASC, p.id ASC`,
    )
    .all() as ProjectRowWithMetrics[];
}

export const projects = {
  list(): Project[] {
    return listProjectsWithMetricsRows().map((r) => {
      const { chat_total, msgs_14, chats_14, ...project } = r;
      return project as Project;
    });
  },
  /** Same order as `list()`, plus chat totals and 14-day activity for hub UI. */
  listWithMetrics(): ProjectListMetrics[] {
    return listProjectsWithMetricsRows().map((r) => {
      const { chat_total, msgs_14, chats_14, ...project } = r;
      return {
        project: project as Project,
        chatTotal: Number(chat_total) || 0,
        messages14d: Number(msgs_14) || 0,
        chats14d: Number(chats_14) || 0,
      };
    });
  },
  get(id: number): Project | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  },
  create(name: string, description?: string | null): Project {
    const info = db
      .prepare(
        'INSERT INTO projects (name, description, logo_emoji, logo_color) VALUES (?, ?, 0, 0)',
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

// ---------- project secrets (tokens / API keys; placeholders in messages) ----------

export type SecretPickerRow = Omit<ProjectSecret, 'value'> & {
  value_length: number;
  project_name: string | null;
  chat_title: string | null;
};

type PickerSqlRow = SecretPickerRow & { value: string };

function stripValueFromPickerRow(row: PickerSqlRow): SecretPickerRow {
  const { value: _v, ...meta } = row;
  return meta;
}

export type SecretPickerSection = {
  label: string;
  items: SecretPickerRow[];
};

export type SecretPickerList = {
  sections: SecretPickerSection[];
};

const PICKER_SELECT = `
  ps.id, ps.project_id, ps.label, ps.source_chat_id, ps.source_message_id,
  ps.created_at, LENGTH(ps.value) AS value_length, ps.value AS value,
  p.name AS project_name, c.title AS chat_title`;

const PICKER_JOINS = `
  FROM project_secrets ps
  LEFT JOIN projects p ON p.id = ps.project_id
  LEFT JOIN chats c ON c.id = ps.source_chat_id`;

function pickerSections(
  ...parts: { label: string; rows: PickerSqlRow[] }[]
): SecretPickerList {
  const seen = new Set<string>();
  const sections: SecretPickerSection[] = [];
  for (const { label, rows } of parts) {
    const items: SecretPickerRow[] = [];
    for (const row of rows) {
      if (seen.has(row.value)) continue;
      seen.add(row.value);
      items.push(stripValueFromPickerRow(row));
    }
    if (items.length > 0) sections.push({ label, items });
  }
  return { sections };
}

/** Whether a stored secret may be revealed / expanded for this chat. */
export function secretUsableInChat(
  secret: ProjectSecret,
  chat: { id: number; project_id: number | null },
): boolean {
  if (chat.project_id != null) return secret.project_id === chat.project_id;
  return secret.project_id == null && secret.source_chat_id === chat.id;
}

export type SecretChatScope = {
  chatId: number | null;
  projectId: number | null;
};

export const projectSecrets = {
  listMetaByProject(
    projectId: number,
  ): (Omit<ProjectSecret, 'value'> & { value_length: number })[] {
    return db
      .prepare(
        `SELECT id, project_id, label, source_chat_id, source_message_id, created_at,
                LENGTH(value) AS value_length
         FROM project_secrets WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(projectId) as (Omit<ProjectSecret, 'value'> & { value_length: number })[];
  },
  get(id: number): ProjectSecret | undefined {
    return db.prepare('SELECT * FROM project_secrets WHERE id = ?').get(id) as
      | ProjectSecret
      | undefined;
  },
  /** Case-insensitive; labels are unique app-wide for user-created secrets. */
  findByLabel(label: string): ProjectSecret | undefined {
    const trimmed = label.trim();
    if (!trimmed) return undefined;
    return db
      .prepare(
        'SELECT * FROM project_secrets WHERE LOWER(TRIM(label)) = LOWER(TRIM(?)) LIMIT 1',
      )
      .get(trimmed) as ProjectSecret | undefined;
  },
  isLabelAvailable(label: string): boolean {
    return this.findByLabel(label) === undefined;
  },
  insert(opts: {
    projectId: number | null;
    label: string;
    value: string;
    sourceChatId: number | null;
    sourceMessageId: number | null;
    /** Picker copy from another project may reuse an existing label. */
    allowDuplicateLabel?: boolean;
  }): ProjectSecret {
    const label = opts.label.trim();
    if (!label) throw new Error('secret label required');
    if (!opts.allowDuplicateLabel) {
      const existing = this.findByLabel(label);
      if (existing) throw new Error('Secret name already exists');
    }
    const value = String(opts.value ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!value) throw new Error('secret value required');
    if (value.length > 32768) throw new Error('secret too long');
    const info = db
      .prepare(
        `INSERT INTO project_secrets (project_id, label, value, source_chat_id, source_message_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.projectId ?? null,
        label,
        value,
        opts.sourceChatId ?? null,
        opts.sourceMessageId ?? null,
      );
    if (opts.projectId != null) projects.touch(opts.projectId);
    return this.get(Number(info.lastInsertRowid))!;
  },
  setSourceMessage(secretId: number, messageId: number): void {
    db.prepare(
      'UPDATE project_secrets SET source_message_id = ? WHERE id = ? AND source_message_id IS NULL',
    ).run(messageId, secretId);
  },
  findByValueInProject(projectId: number, value: string): ProjectSecret | undefined {
    return db
      .prepare('SELECT * FROM project_secrets WHERE project_id = ? AND value = ? LIMIT 1')
      .get(projectId, value) as ProjectSecret | undefined;
  },
  findByValueOrphanInChat(chatId: number, value: string): ProjectSecret | undefined {
    return db
      .prepare(
        'SELECT * FROM project_secrets WHERE project_id IS NULL AND source_chat_id = ? AND value = ? LIMIT 1',
      )
      .get(chatId, value) as ProjectSecret | undefined;
  },
  listForComposerPicker(projectId: number): SecretPickerList {
    const projectRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE ps.project_id = ?
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(projectId) as PickerSqlRow[];
    const otherRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE ps.project_id IS NOT NULL AND ps.project_id != ?
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(projectId) as PickerSqlRow[];
    return pickerSections(
      { label: 'This project', rows: projectRows },
      { label: 'Other', rows: otherRows },
    );
  },
  listForComposerPickerInProjectChat(
    chatId: number,
    projectId: number,
  ): SecretPickerList {
    const thisChatRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE ps.source_chat_id = ? AND ps.project_id = ?
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(chatId, projectId) as PickerSqlRow[];
    const thisProjectRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE ps.project_id = ?
           AND (ps.source_chat_id IS NULL OR ps.source_chat_id != ?)
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(projectId, chatId) as PickerSqlRow[];
    const otherRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE (ps.project_id IS NOT NULL AND ps.project_id != ?)
            OR (ps.project_id IS NULL
                AND (ps.source_chat_id IS NULL OR ps.source_chat_id != ?))
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(projectId, chatId) as PickerSqlRow[];
    return pickerSections(
      { label: 'This chat', rows: thisChatRows },
      { label: 'This project', rows: thisProjectRows },
      { label: 'Other', rows: otherRows },
    );
  },
  listForComposerPickerChat(chatId: number): SecretPickerList {
    const thisChatRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE ps.project_id IS NULL AND ps.source_chat_id = ?
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(chatId) as PickerSqlRow[];
    const otherRows = db
      .prepare(
        `SELECT ${PICKER_SELECT}
         ${PICKER_JOINS}
         WHERE (ps.project_id IS NULL AND (ps.source_chat_id IS NULL OR ps.source_chat_id != ?))
            OR ps.project_id IS NOT NULL
         ORDER BY ps.created_at DESC, ps.id DESC`,
      )
      .all(chatId) as PickerSqlRow[];
    return pickerSections(
      { label: 'This chat', rows: thisChatRows },
      { label: '', rows: otherRows },
    );
  },
  listForComposerPickerForChat(chat: { id: number; project_id: number | null }): SecretPickerList {
    if (chat.project_id != null) {
      return this.listForComposerPickerInProjectChat(chat.id, chat.project_id);
    }
    return this.listForComposerPickerChat(chat.id);
  },
  resolveForChat(scope: SecretChatScope, secretId: number): ProjectSecret {
    const src = this.get(secretId);
    if (!src) throw new Error('secret not found');
    if (scope.projectId != null) {
      if (src.project_id === scope.projectId) return src;
      const sameValue = this.findByValueInProject(scope.projectId, src.value);
      if (sameValue) return sameValue;
      return this.insert({
        projectId: scope.projectId,
        label: src.label,
        value: src.value,
        sourceChatId: scope.chatId,
        sourceMessageId: null,
        allowDuplicateLabel: true,
      });
    }
    if (scope.chatId == null) throw new Error('chat required');
    const chat = { id: scope.chatId, project_id: null as number | null };
    if (secretUsableInChat(src, chat)) return src;
    const sameValue = this.findByValueOrphanInChat(scope.chatId, src.value);
    if (sameValue) return sameValue;
    return this.insert({
      projectId: null,
      label: src.label,
      value: src.value,
      sourceChatId: scope.chatId,
      sourceMessageId: null,
      allowDuplicateLabel: true,
    });
  },
};

// ---------- queued messages (composer queue) ----------

type QueuedRow = Omit<QueuedMessage, 'attachments'> & { attachments: string | null };

function parseQueuedRow(row: QueuedRow): QueuedMessage {
  let attachments: QueuedMessage['attachments'] = null;
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      /* corrupt JSON */
    }
  }
  return { ...row, attachments };
}

export const queuedMessages = {
  listByChat(chatId: number): QueuedMessage[] {
    const rows = db
      .prepare(
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, created_at FROM queued_messages WHERE chat_id = ? ORDER BY position ASC, id ASC',
      )
      .all(chatId) as QueuedRow[];
    return rows.map(parseQueuedRow);
  },
  get(id: number): QueuedMessage | undefined {
    const row = db
      .prepare(
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, created_at FROM queued_messages WHERE id = ?',
      )
      .get(id) as QueuedRow | undefined;
    return row ? parseQueuedRow(row) : undefined;
  },
  /** Raw row including inline_secrets JSON — only for flush. */
  getForFlush(id: number):
    | (QueuedMessage & { inline_secrets: InlineSecretWire[] | null })
    | undefined {
    const row = db
      .prepare(
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, inline_secrets, created_at FROM queued_messages WHERE id = ?',
      )
      .get(id) as (QueuedRow & { inline_secrets: string | null }) | undefined;
    if (!row) return undefined;
    let inline_secrets: InlineSecretWire[] | null = null;
    if (row.inline_secrets) {
      try {
        const parsed = JSON.parse(row.inline_secrets);
        if (Array.isArray(parsed)) inline_secrets = parsed;
      } catch {
        /* ignore */
      }
    }
    const { inline_secrets: _raw, ...rest } = row;
    return { ...parseQueuedRow(rest), inline_secrets };
  },
  create(opts: {
    chatId: number;
    content: string;
    replyTo?: { messageId: number; quote: string; role?: string } | null;
    attachments?: MessageAttachment[] | null;
    inlineSecrets?: InlineSecretWire[] | null;
  }): QueuedMessage {
    const trimmed = opts.content.trim();
    const hasAttachments = opts.attachments && opts.attachments.length > 0;
    if (!trimmed && !hasAttachments) throw new Error('content or attachments required');
    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM queued_messages WHERE chat_id = ?')
      .get(opts.chatId) as { m: number };
    const position = maxPos.m + 1;
    const attachmentsJson =
      opts.attachments && opts.attachments.length > 0 ? JSON.stringify(opts.attachments) : null;
    const inlineJson =
      opts.inlineSecrets && opts.inlineSecrets.length > 0
        ? JSON.stringify(opts.inlineSecrets)
        : null;
    const info = db
      .prepare(
        `INSERT INTO queued_messages (
          chat_id, content, reply_to_message_id, reply_quote, reply_to_role,
          attachments, inline_secrets, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.chatId,
        trimmed || '',
        opts.replyTo?.messageId ?? null,
        opts.replyTo?.quote ?? null,
        opts.replyTo?.role ?? null,
        attachmentsJson,
        inlineJson,
        position,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id);
  },
  /** Move a row to the front of this chat's queue (interrupt-and-send). */
  promoteToFront(chatId: number, id: number): QueuedMessage | undefined {
    const row = this.get(id);
    if (!row || row.chat_id !== chatId) return undefined;
    const minRow = db
      .prepare('SELECT MIN(position) AS m FROM queued_messages WHERE chat_id = ?')
      .get(chatId) as { m: number | null };
    const nextPos = (minRow.m ?? 1) - 1;
    db.prepare('UPDATE queued_messages SET position = ? WHERE id = ?').run(nextPos, id);
    return this.get(id);
  },
};

// ---------- scheduled messages ----------

/**
 * Convert an ISO string (or `Date`) into the same UTC `YYYY-MM-DD HH:MM:SS`
 * format that SQLite's `datetime('now')` produces, so direct string comparison
 * picks up due rows. Throws on invalid input — callers should validate first.
 */
function toSqliteUtc(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error('invalid scheduled_at');
  }
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export const scheduledMessages = {
  listByChat(chatId: number): ScheduledMessage[] {
    return db
      .prepare(
        'SELECT * FROM scheduled_messages WHERE chat_id = ? ORDER BY scheduled_at ASC, id ASC',
      )
      .all(chatId) as ScheduledMessage[];
  },
  get(id: number): ScheduledMessage | undefined {
    return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as
      | ScheduledMessage
      | undefined;
  },
  /** Rows whose `scheduled_at` is now or in the past — what the sweeper fires. */
  listDue(limit = 50): ScheduledMessage[] {
    return db
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE scheduled_at <= datetime('now')
         ORDER BY scheduled_at ASC, id ASC
         LIMIT ?`,
      )
      .all(limit) as ScheduledMessage[];
  },
  create(opts: {
    chatId: number;
    content: string;
    scheduledAt: string | Date;
  }): ScheduledMessage {
    const trimmed = opts.content.trim();
    if (!trimmed) throw new Error('content required');
    const at = toSqliteUtc(opts.scheduledAt);
    const info = db
      .prepare(
        'INSERT INTO scheduled_messages (chat_id, content, scheduled_at) VALUES (?, ?, ?)',
      )
      .run(opts.chatId, trimmed, at);
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  },
  update(
    id: number,
    patch: { content?: string; scheduledAt?: string | Date },
  ): ScheduledMessage | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    const content =
      patch.content !== undefined ? patch.content.trim() : row.content;
    if (!content) throw new Error('content required');
    const scheduled_at =
      patch.scheduledAt !== undefined
        ? toSqliteUtc(patch.scheduledAt)
        : row.scheduled_at;
    db.prepare(
      'UPDATE scheduled_messages SET content = ?, scheduled_at = ? WHERE id = ?',
    ).run(content, scheduled_at, id);
    return this.get(id);
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
         WHERE instr(unicode_lower(c.title), ?) > 0
            OR instr(unicode_lower(COALESCE(m.content, '')), ?) > 0
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 500`,
      )
      .all(needle, needle) as { id: number }[];
    return rows.map((r) => r.id);
  },
};
