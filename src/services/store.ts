import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { deriveTitle } from './chatTitle';
import type {
  Chat,
  ChatKind,
  ChatMode,
  Message,
  MessageAttachment,
  Project,
  ProjectFact,
  ProjectFactSuggestion,
  ProjectSkill,
  ProjectSkillSuggestion,
  ProjectSecret,
  QueuedMessage,
  ScheduledMessage,
  Task,
  TaskAskSession,
  TaskContextSnapshot,
  TaskContextSnapshotPayload,
  TaskRun,
  TaskStatus,
  TaskStep,
  TaskStepActor,
  TaskStepStatus,
  TaskWithSteps,
  ToolTraceEntry,
} from '../types';
import type { InlineSecretWire } from './inlineSecrets';
import { DEFAULT_MODE } from './chatModes';
import { clampLogoColor, clampLogoEmoji } from '../constants/projectLogos';

// ---------- chats ----------

const CHAT_KIND_NORMAL = "COALESCE(chat_kind, 'normal') = 'normal'";

export const chats = {
  list(): Chat[] {
    return db
      .prepare(
        `SELECT * FROM chats WHERE ${CHAT_KIND_NORMAL} ORDER BY updated_at DESC, id DESC`,
      )
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
        `SELECT * FROM chats WHERE project_id IS NULL AND ${CHAT_KIND_NORMAL} ORDER BY updated_at DESC, id DESC`,
      )
      .all() as Chat[];
  },
  listByProject(projectId: number): Chat[] {
    return db
      .prepare(
        `SELECT * FROM chats WHERE project_id = ? AND ${CHAT_KIND_NORMAL} ORDER BY updated_at DESC, id DESC`,
      )
      .all(projectId) as Chat[];
  },
  create(
    agent: string,
    projectId: number | null = null,
    opts?: { chatKind?: ChatKind; title?: string },
  ): Chat {
    const sessionKey = randomUUID();
    const kind = opts?.chatKind ?? 'normal';
    const title = opts?.title?.trim() || 'New chat';
    const info = db
      .prepare(
        'INSERT INTO chats (agent, openclaw_session_id, project_id, chat_kind, title) VALUES (?, ?, ?, ?, ?)',
      )
      .run(agent, sessionKey, projectId, kind, title);
    return this.get(Number(info.lastInsertRowid))!;
  },
  /** Composer-only row — hidden from sidebar until promoted on first user message. */
  isDraft(id: number): boolean {
    const row = this.get(id);
    return row?.chat_kind === 'draft';
  },
  promoteFromDraft(id: number): boolean {
    const info = db
      .prepare(
        "UPDATE chats SET chat_kind = 'normal' WHERE id = ? AND COALESCE(chat_kind, 'normal') = 'draft'",
      )
      .run(id);
    return info.changes > 0;
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
  /** Persist the chat's sticky composer send-mode (see chats.mode). */
  setChatMode(id: number, mode: string): void {
    db.prepare(
      "UPDATE chats SET mode = ?, updated_at = datetime('now') WHERE id = ?",
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

type MessageRow = Omit<Message, 'attachments' | 'tool_trace'> & {
  attachments: string | null;
  tool_trace: string | null;
};

/** Parse the `attachments` / `tool_trace` TEXT columns (JSON strings) into typed arrays. */
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
  let tool_trace: Message['tool_trace'] = null;
  if (row.tool_trace) {
    try {
      const parsed = JSON.parse(row.tool_trace);
      if (Array.isArray(parsed)) tool_trace = parsed;
    } catch {
      // Corrupt JSON — drop the trace, keep the message readable.
    }
  }
  return { ...row, attachments, tool_trace };
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
    /** Send mode for user rows. Defaults to 'execute' (back-compat). */
    mode: ChatMode = DEFAULT_MODE,
    /** Total tokens spent producing this message (dev-mode; assistant rows). */
    tokens: number | null = null,
    /** Of `tokens`, prompt tokens served from cache (dev-mode). */
    cachedTokens: number | null = null,
    /** Verified tool outcomes for the turn (assistant rows in runtime modes). */
    toolTrace: ToolTraceEntry[] | null = null,
  ): Message {
    const rid = reply?.replyToMessageId ?? null;
    const rq = reply?.replyQuote ?? null;
    const rrole = reply?.replyToRole ?? null;
    const att =
      attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
    const trace =
      toolTrace && toolTrace.length > 0 ? JSON.stringify(toolTrace) : null;
    const info = db
      .prepare(
        'INSERT INTO messages (chat_id, role, content, finish_reason, reply_to_message_id, reply_quote, reply_to_role, attachments, mode, tokens, cached_tokens, tool_trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(chatId, role, content, finishReason, rid, rq, rrole, att, mode, tokens, cachedTokens, trace);
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

// ---------- project skills (procedural memory; SKILL.md) ----------

/** name + description only — for prompt injection / panel list. */
export interface ProjectSkillIndexRow {
  id: number;
  name: string;
  description: string;
}

export const projectSkills = {
  /** Active skills for a project (does NOT include global; merge in the caller). */
  listByProject(projectId: number): ProjectSkill[] {
    return db
      .prepare(
        'SELECT * FROM project_skills WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
      )
      .all(projectId) as ProjectSkill[];
  },
  listGlobal(): ProjectSkill[] {
    return db
      .prepare(
        'SELECT * FROM project_skills WHERE project_id IS NULL ORDER BY updated_at DESC, id DESC',
      )
      .all() as ProjectSkill[];
  },
  /** Active skills visible to a project: its own skills plus all global skills. */
  listForProject(projectId: number): ProjectSkill[] {
    return [...this.listByProject(projectId), ...this.listGlobal()];
  },
  get(id: number): ProjectSkill | undefined {
    return db.prepare('SELECT * FROM project_skills WHERE id = ?').get(id) as
      | ProjectSkill
      | undefined;
  },
  getByName(projectId: number | null, name: string): ProjectSkill | undefined {
    const trimmed = name.trim();
    if (projectId == null) {
      return db
        .prepare('SELECT * FROM project_skills WHERE project_id IS NULL AND name = ?')
        .get(trimmed) as ProjectSkill | undefined;
    }
    return db
      .prepare('SELECT * FROM project_skills WHERE project_id = ? AND name = ?')
      .get(projectId, trimmed) as ProjectSkill | undefined;
  },
  /** Index (id/name/description) of all skills visible to a project. */
  listIndex(projectId: number): ProjectSkillIndexRow[] {
    return this.listForProject(projectId).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    }));
  },
  create(opts: {
    projectId: number | null;
    name: string;
    description: string;
    body: string;
    tags?: string[] | null;
    sourceChatId?: number | null;
  }): ProjectSkill {
    const name = opts.name.trim();
    const description = opts.description.trim();
    const body = opts.body.trim();
    if (!name) throw new Error('skill name required');
    if (!description) throw new Error('skill description required');
    if (!body) throw new Error('skill body required');
    const tags = opts.tags && opts.tags.length > 0 ? JSON.stringify(opts.tags) : null;
    const info = db
      .prepare(
        `INSERT INTO project_skills (project_id, name, description, body, tags, source_chat_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.projectId, name, description, body, tags, opts.sourceChatId ?? null);
    if (opts.projectId != null) projects.touch(opts.projectId);
    return this.get(Number(info.lastInsertRowid))!;
  },
  /** Patch description/body/tags/name; bumps version + updated_at. */
  update(
    id: number,
    patch: { description?: string; body?: string; tags?: string[] | null; name?: string },
  ): void {
    const existing = this.get(id);
    if (!existing) return;
    const name = patch.name != null ? patch.name.trim() : existing.name;
    const description =
      patch.description != null ? patch.description.trim() : existing.description;
    const body = patch.body != null ? patch.body.trim() : existing.body;
    const tags =
      patch.tags !== undefined
        ? patch.tags && patch.tags.length > 0
          ? JSON.stringify(patch.tags)
          : null
        : existing.tags;
    db.prepare(
      `UPDATE project_skills
         SET name = ?, description = ?, body = ?, tags = ?,
             version = version + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(name, description, body, tags, id);
    if (existing.project_id != null) projects.touch(existing.project_id);
  },
  incrementUsage(id: number): void {
    db.prepare('UPDATE project_skills SET usage_count = usage_count + 1 WHERE id = ?').run(id);
  },
  remove(id: number): void {
    const row = this.get(id);
    db.prepare('DELETE FROM project_skills WHERE id = ?').run(id);
    if (row?.project_id != null) projects.touch(row.project_id);
  },
};

// ---------- project skill suggestions (user confirm in chat; inbox-gated) ----------

export const projectSkillSuggestions = {
  listByChat(chatId: number): ProjectSkillSuggestion[] {
    return db
      .prepare(
        'SELECT * FROM project_skill_suggestions WHERE chat_id = ? ORDER BY id ASC',
      )
      .all(chatId) as ProjectSkillSuggestion[];
  },
  listByProject(projectId: number): ProjectSkillSuggestion[] {
    return db
      .prepare(
        'SELECT * FROM project_skill_suggestions WHERE project_id = ? ORDER BY id ASC',
      )
      .all(projectId) as ProjectSkillSuggestion[];
  },
  get(id: number): ProjectSkillSuggestion | undefined {
    return db.prepare('SELECT * FROM project_skill_suggestions WHERE id = ?').get(id) as
      | ProjectSkillSuggestion
      | undefined;
  },
  insert(opts: {
    projectId: number;
    chatId: number;
    kind: 'new' | 'patch';
    targetSkillId?: number | null;
    name: string;
    description: string;
    body: string;
    tags?: string[] | null;
    untrusted?: boolean;
    assistantMessageId: number | null;
  }): ProjectSkillSuggestion {
    const name = opts.name.trim();
    const description = opts.description.trim();
    const body = opts.body.trim();
    if (!name) throw new Error('suggestion name required');
    if (!description) throw new Error('suggestion description required');
    if (!body) throw new Error('suggestion body required');
    const tags = opts.tags && opts.tags.length > 0 ? JSON.stringify(opts.tags) : null;
    const info = db
      .prepare(
        `INSERT INTO project_skill_suggestions
           (project_id, chat_id, kind, target_skill_id, name, description, body, tags, untrusted, assistant_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.projectId,
        opts.chatId,
        opts.kind,
        opts.targetSkillId ?? null,
        name,
        description,
        body,
        tags,
        opts.untrusted ? 1 : 0,
        opts.assistantMessageId ?? null,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM project_skill_suggestions WHERE id = ?').run(id);
  },
};

/** UI: attach source chat title from `chats` (not persisted on `project_skills`). */
export function enrichSkillWithSourceChatTitle(skill: ProjectSkill): ProjectSkill {
  const sid = skill.source_chat_id;
  if (sid == null) return { ...skill };
  const c = chats.get(sid);
  const source_chat_title = (c?.title ?? '').trim() || 'Chat';
  return { ...skill, source_chat_title };
}

export function enrichSkillsWithSourceChatTitles(skills: ProjectSkill[]): ProjectSkill[] {
  return skills.map(enrichSkillWithSourceChatTitle);
}

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
  /** Full rows (with values) expandable in this chat — same scope rule as secretUsableInChat. */
  listUsableInChat(chat: { id: number; project_id: number | null }): ProjectSecret[] {
    if (chat.project_id != null) {
      return db
        .prepare('SELECT * FROM project_secrets WHERE project_id = ?')
        .all(chat.project_id) as ProjectSecret[];
    }
    return db
      .prepare('SELECT * FROM project_secrets WHERE project_id IS NULL AND source_chat_id = ?')
      .all(chat.id) as ProjectSecret[];
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
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, mode, created_at FROM queued_messages WHERE chat_id = ? ORDER BY position ASC, id ASC',
      )
      .all(chatId) as QueuedRow[];
    return rows.map(parseQueuedRow);
  },
  get(id: number): QueuedMessage | undefined {
    const row = db
      .prepare(
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, mode, created_at FROM queued_messages WHERE id = ?',
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
        'SELECT id, chat_id, content, reply_to_message_id, reply_quote, reply_to_role, attachments, mode, inline_secrets, created_at FROM queued_messages WHERE id = ?',
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
    replyTo?: { messageId: number; quote: string; role?: string | undefined } | null;
    attachments?: MessageAttachment[] | null;
    inlineSecrets?: InlineSecretWire[] | null;
    mode?: ChatMode;
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
          attachments, inline_secrets, mode, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.chatId,
        trimmed || '',
        opts.replyTo?.messageId ?? null,
        opts.replyTo?.quote ?? null,
        opts.replyTo?.role ?? null,
        attachmentsJson,
        inlineJson,
        opts.mode ?? DEFAULT_MODE,
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
  /** Distinct chat ids with at least one pending scheduled row (sidebar dots). */
  chatIdsWithPending(): number[] {
    return Object.keys(this.pendingCountByChatId()).map(Number);
  },
  /** Pending scheduled row counts keyed by chat id (sidebar + bootstrapping). */
  pendingCountByChatId(): Record<number, number> {
    const rows = db
      .prepare(
        `SELECT chat_id, COUNT(*) AS n
         FROM scheduled_messages
         GROUP BY chat_id
         ORDER BY chat_id ASC`,
      )
      .all() as { chat_id: number; n: number }[];
    const out: Record<number, number> = {};
    for (const r of rows) out[r.chat_id] = r.n;
    return out;
  },
  countByChat(chatId: number): number {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE chat_id = ?')
      .get(chatId) as { n: number };
    return row.n;
  },
  get(id: number): ScheduledMessage | undefined {
    return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as
      | ScheduledMessage
      | undefined;
  },
  /** How many scheduled messages this user has EVER created (monotonic,
   * survives delete-after-fire). Reads sqlite_sequence directly — the
   * AUTOINCREMENT counter never goes down. Used by the discovery hint to
   * decide whether the user has discovered the feature for good. */
  everCreatedCount(): number {
    const row = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'scheduled_messages'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
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

// ---------- tasks ----------

export const taskContextSnapshots = {
  create(opts: {
    projectId: number | null;
    sourceChatId: number;
    payload: TaskContextSnapshotPayload;
  }): TaskContextSnapshot {
    const info = db
      .prepare(
        'INSERT INTO task_context_snapshots (project_id, source_chat_id, content_json) VALUES (?, ?, ?)',
      )
      .run(opts.projectId, opts.sourceChatId, JSON.stringify(opts.payload));
    return db
      .prepare('SELECT * FROM task_context_snapshots WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as TaskContextSnapshot;
  },
  get(id: number): TaskContextSnapshot | undefined {
    return db.prepare('SELECT * FROM task_context_snapshots WHERE id = ?').get(id) as
      | TaskContextSnapshot
      | undefined;
  },
  parsePayload(row: TaskContextSnapshot): TaskContextSnapshotPayload {
    return JSON.parse(row.content_json) as TaskContextSnapshotPayload;
  },
  delete(id: number): void {
    db.prepare('DELETE FROM task_context_snapshots WHERE id = ?').run(id);
  },
};

export const taskAskSessions = {
  create(opts: {
    taskId: number;
    contextSnapshotId: number;
    openclawSessionKey: string;
  }): TaskAskSession {
    const info = db
      .prepare(
        `INSERT INTO task_ask_sessions (task_id, context_snapshot_id, openclaw_session_key, turn_count)
         VALUES (?, ?, ?, 0)`,
      )
      .run(opts.taskId, opts.contextSnapshotId, opts.openclawSessionKey);
    return db
      .prepare('SELECT * FROM task_ask_sessions WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as TaskAskSession;
  },
  get(id: number): TaskAskSession | undefined {
    return db.prepare('SELECT * FROM task_ask_sessions WHERE id = ?').get(id) as
      | TaskAskSession
      | undefined;
  },
  listOpenByTask(taskId: number): TaskAskSession[] {
    return db
      .prepare('SELECT * FROM task_ask_sessions WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as TaskAskSession[];
  },
  incrementTurnCount(id: number): void {
    db.prepare(
      'UPDATE task_ask_sessions SET turn_count = turn_count + 1 WHERE id = ?',
    ).run(id);
  },
  delete(id: number): void {
    db.prepare('DELETE FROM task_ask_sessions WHERE id = ?').run(id);
  },
};

function touchTask(id: number): void {
  db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(id);
}

export const tasks = {
  get(id: number): Task | undefined {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  },
  hasAny(): boolean {
    const row = db.prepare('SELECT 1 AS n FROM tasks LIMIT 1').get() as { n: number } | undefined;
    return row != null;
  },
  /** How many tasks this user has EVER created (monotonic, survives row
   * deletion). Reads sqlite_sequence directly — the AUTOINCREMENT counter
   * never goes down. Used by the send-button discovery hint. */
  everCreatedCount(): number {
    const row = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  },
  statusSignals(): { needsHuman: boolean; running: boolean; needsReview: boolean } {
    const row = db
      .prepare(
        `SELECT
          MAX(CASE WHEN status IN ('needs_human', 'needs_clarification') THEN 1 ELSE 0 END) AS needs_human,
          MAX(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          MAX(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review
        FROM tasks`,
      )
      .get() as
      | { needs_human: number; running: number; needs_review: number }
      | undefined;
    return {
      needsHuman: (row?.needs_human ?? 0) > 0,
      running: (row?.running ?? 0) > 0,
      needsReview: (row?.needs_review ?? 0) > 0,
    };
  },
  list(opts?: { projectId?: number | null; orphanOnly?: boolean }): Task[] {
    if (opts?.orphanOnly) {
      return db
        .prepare('SELECT * FROM tasks WHERE project_id IS NULL ORDER BY updated_at DESC, id DESC')
        .all() as Task[];
    }
    if (opts?.projectId != null) {
      return db
        .prepare(
          'SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
        )
        .all(opts.projectId) as Task[];
    }
    return db
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id DESC')
      .all() as Task[];
  },
  create(opts: {
    projectId: number | null;
    sourceChatId: number;
    title: string;
    goal: string;
    agent: string | null;
    contextSnapshotId: number;
    status?: TaskStatus;
  }): Task {
    const info = db
      .prepare(
        `INSERT INTO tasks (
          project_id, source_chat_id, title, goal, status, agent, context_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.projectId,
        opts.sourceChatId,
        opts.title.trim() || 'Task',
        opts.goal.trim(),
        opts.status ?? 'ready',
        opts.agent,
        opts.contextSnapshotId,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  updateStatus(id: number, status: TaskStatus): void {
    db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      id,
    );
  },
  patch(
    id: number,
    patch: {
      title?: string;
      goal?: string;
      agent?: string | null;
      status?: TaskStatus;
      executionChatId?: number | null;
      resultSummary?: string | null;
    },
  ): Task | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    const title = patch.title !== undefined ? patch.title.trim() || row.title : row.title;
    const goal = patch.goal !== undefined ? patch.goal.trim() : row.goal;
    const agent = patch.agent !== undefined ? patch.agent : row.agent;
    const status = patch.status ?? row.status;
    const execution_chat_id =
      patch.executionChatId !== undefined ? patch.executionChatId : row.execution_chat_id;
    const result_summary =
      patch.resultSummary !== undefined ? patch.resultSummary : row.result_summary;
    db.prepare(
      `UPDATE tasks SET title = ?, goal = ?, agent = ?, status = ?,
        execution_chat_id = ?, result_summary = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(title, goal, agent, status, execution_chat_id, result_summary, id);
    return this.get(id);
  },
  remove(id: number): { executionChatId: number | null; snapshotId: number } | null {
    const task = this.get(id);
    if (!task) return null;
    const meta = {
      executionChatId: task.execution_chat_id,
      snapshotId: task.context_snapshot_id,
    };
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    db.prepare('DELETE FROM task_context_snapshots WHERE id = ?').run(task.context_snapshot_id);
    return meta;
  },
};

export const taskSteps = {
  listByTask(taskId: number): TaskStep[] {
    return db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY position ASC, id ASC')
      .all(taskId) as TaskStep[];
  },
  replaceAll(
    taskId: number,
    steps: {
      id?: number;
      actor: TaskStepActor;
      title: string;
      description?: string | null;
    }[],
  ): TaskStep[] {
    const existing = this.listByTask(taskId);
    const locked = new Map(
      existing
        .filter((s) => s.status === 'done' || s.status === 'failed')
        .map((s) => [s.id, s]),
    );
    const del = db.prepare('DELETE FROM task_steps WHERE task_id = ?');
    const ins = db.prepare(
      `INSERT INTO task_steps (
         task_id, position, actor, title, description, status, result_summary, result_body
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = db.transaction(() => {
      del.run(taskId);
      steps.forEach((s, i) => {
        const stepId = s.id != null ? Number(s.id) : NaN;
        const preserved = Number.isFinite(stepId) ? locked.get(stepId) : undefined;
        if (preserved) {
          ins.run(
            taskId,
            i,
            preserved.actor,
            preserved.title,
            preserved.description,
            preserved.status,
            preserved.result_summary,
            preserved.result_body,
          );
        } else {
          ins.run(
            taskId,
            i,
            s.actor,
            s.title.trim(),
            s.description?.trim() || null,
            'todo',
            null,
            null,
          );
        }
      });
    });
    run();
    touchTask(taskId);
    return this.listByTask(taskId);
  },
  saveResult(stepId: number, body: string | null, summary?: string | null): void {
    const b =
      body != null && String(body).trim() ? String(body).trim().slice(0, 20_000) : null;
    const sum =
      summary != null && String(summary).trim()
        ? String(summary).trim().slice(0, 500)
        : null;
    db.prepare(
      `UPDATE task_steps SET result_summary = ?, result_body = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(sum, b, stepId);
  },
  updateStatus(stepId: number, status: TaskStepStatus): void {
    db.prepare(
      "UPDATE task_steps SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, stepId);
  },
  /** Insert a human gate after an existing step; shifts later positions. */
  insertHumanAfter(taskId: number, afterStepId: number, title: string): TaskStep {
    const after = db
      .prepare('SELECT * FROM task_steps WHERE id = ? AND task_id = ?')
      .get(afterStepId, taskId) as TaskStep | undefined;
    if (!after) throw new Error('step not found');
    const label = title.trim() || 'Your input needed';
    const newPos = after.position + 1;
    const bump = db.prepare(
      'UPDATE task_steps SET position = position + 1 WHERE task_id = ? AND position >= ?',
    );
    const ins = db.prepare(
      `INSERT INTO task_steps (task_id, position, actor, title, description, status)
       VALUES (?, ?, 'human', ?, NULL, 'needs_human')`,
    );
    const run = db.transaction(() => {
      bump.run(taskId, newPos);
      ins.run(taskId, newPos, label);
    });
    run();
    touchTask(taskId);
    const row = db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? AND position = ?')
      .get(taskId, newPos) as TaskStep;
    return row;
  },
  /** First plan step that is not finished (done/failed). */
  getActiveStep(taskId: number): TaskStep | undefined {
    const steps = this.listByTask(taskId);
    return steps.find((s) => s.status !== 'done' && s.status !== 'failed');
  },
  getCurrentTodo(taskId: number): TaskStep | undefined {
    return this.getActiveStep(taskId);
  },
};

export const taskRuns = {
  create(opts: {
    taskId: number;
    executionChatId: number;
    status: string;
    taskStepId?: number | null;
  }): TaskRun {
    const info = db
      .prepare(
        'INSERT INTO task_runs (task_id, execution_chat_id, task_step_id, status) VALUES (?, ?, ?, ?)',
      )
      .run(opts.taskId, opts.executionChatId, opts.taskStepId ?? null, opts.status);
    return db.prepare('SELECT * FROM task_runs WHERE id = ?').get(Number(info.lastInsertRowid)) as TaskRun;
  },
  finish(id: number, status: string, logSummary: string | null): void {
    db.prepare(
      `UPDATE task_runs SET status = ?, finished_at = datetime('now'), log_summary = ? WHERE id = ?`,
    ).run(status, logSummary, id);
  },
  listByTask(taskId: number): TaskRun[] {
    return db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC')
      .all(taskId) as TaskRun[];
  },
  getLatest(taskId: number): TaskRun | undefined {
    return db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as TaskRun | undefined;
  },
};

export function enrichTaskWithSteps(task: Task): TaskWithSteps {
  const steps = taskSteps.listByTask(task.id);
  const src = chats.get(task.source_chat_id);
  const current = taskSteps.getActiveStep(task.id);
  return {
    ...task,
    steps,
    source_chat_title: (src?.title ?? '').trim() || 'Chat',
    current_step_title: current?.title,
  };
}

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
         WHERE ${CHAT_KIND_NORMAL}
           AND (instr(unicode_lower(c.title), ?) > 0
            OR instr(unicode_lower(COALESCE(m.content, '')), ?) > 0)
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 500`,
      )
      .all(needle, needle) as { id: number }[];
    return rows.map((r) => r.id);
  },
};
