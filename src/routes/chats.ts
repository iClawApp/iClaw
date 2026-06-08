import { Router } from 'express';
import {
  chats,
  messages,
  chatSearch,
  projects,
  projectFactSuggestions,
  projectFacts,
  projectSkills,
  projectSkillSuggestions,
  projectSecrets,
  secretUsableInChat,
  scheduledMessages,
  queuedMessages,
  tasks,
  enrichFactWithSourceChatTitle,
  enrichSkillWithSourceChatTitle,
} from '../services/store';
import { persistIncomingAttachments, type IncomingAttachment } from '../services/uploads';
import {
  redactSelectionInMessageContent,
  resolveInlineSecretMarkersInContent,
} from '../services/inlineSecrets';
import type { InlineSecretWire } from '../services/inlineSecrets';
import { compactProjectFacts } from '../services/projectMemory';
import { openclawWs } from '../services/openclawWs';
import { openclaw, cloudShareBaseUrl } from '../services/openclaw';
import { chatStatus } from '../services/chatStatus';
import { wsHub } from '../services/wsHub';
import { sendMessage, getWorkSessionId, destroyWorkSession, exportChatSandbox, applyChatSandboxChanges } from '../services/chatRunner';
import { getWorkspaceInfo } from '../services/workRuntime';
import {
  defaultComposerMode,
  isSelectableMode,
  isEphemeralMode,
  listComposerModes,
  normalizeChatMode,
} from '../services/chatModes';
import type { ChatMode } from '../types';
import { shouldShowSendHint } from '../services/sendHint';
import { openRouterEnabled } from '../services/openRouter';

export const chatsRouter: Router = Router();

const DEFAULT_AGENT = 'openclaw/default';

async function getAgentsSafe(): Promise<{
  agents: { id: string }[];
  error: string | null;
}> {
  try {
    const list = await openclawWs.listAgents();
    const items: { id: string }[] = [{ id: DEFAULT_AGENT }];
    for (const a of list) items.push({ id: `openclaw/${a.id}` });
    return { agents: items, error: null };
  } catch (err) {
    return { agents: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Legacy GET — kept so any client that hits /chats/status still gets a 200. */
chatsRouter.get('/status', (_req, res) => {
  res.json({
    working: chatStatus.workingIds(),
    activities: chatStatus.snapshot(),
  });
});

/** JSON search — must stay above `/:id` so "search" is not parsed as an id. */
chatsRouter.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const ids = chatSearch.matchingChatIds(q);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.type('application/json').json({ ids });
});

/**
 * Create a draft composer chat (hidden from sidebar until the first user message).
 * Body: `{ agent?: string, projectId?: number | null }`.
 */
chatsRouter.post('/', (req, res) => {
  const agent = String(req.body?.agent ?? '').trim() || DEFAULT_AGENT;
  let projectId: number | null = null;
  const rawProject = req.body?.projectId;
  if (rawProject != null && rawProject !== '') {
    const n = Number(rawProject);
    if (Number.isFinite(n) && n > 0 && projects.get(n)) projectId = n;
  }
  const chat = chats.create(agent, projectId, { chatKind: 'draft' });
  const proj = projectId != null ? projects.get(projectId) : null;
  res.status(201).type('application/json').json({
    chatId: chat.id,
    title: chat.title,
    agent: chat.agent,
    projectId: chat.project_id,
    projectName: proj?.name ?? null,
    updatedAt: chat.updated_at,
    draft: true,
  });
});

/** Pending project-fact suggestions for this chat (JSON). */
chatsRouter.get('/:id/fact-suggestions', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const suggestions = projectFactSuggestions.listByChat(id);
  const first = suggestions[0];
  const projectName =
    first != null ? (projects.get(first.project_id)?.name?.trim() ?? 'project') : null;
  res.type('application/json').json({ suggestions, projectName });
});

chatsRouter.post('/:id/fact-suggestions/:suggestionId/accept', (req, res) => {
  const chatId = Number(req.params.id);
  const sid = Number(req.params.suggestionId);
  if (!Number.isFinite(chatId) || !Number.isFinite(sid)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const chat = chats.get(chatId);
  const sug = projectFactSuggestions.get(sid);
  if (!chat || !sug || sug.chat_id !== chatId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!chat.project_id || chat.project_id !== sug.project_id) {
    res.status(400).json({ error: 'project mismatch' });
    return;
  }
  const fact = projectFacts.append({
    projectId: sug.project_id,
    content: sug.content,
    sourceChatId: chatId,
    sourceMessageId: sug.assistant_message_id,
  });
  projectFactSuggestions.remove(sid);
  wsHub.broadcastAll({
    type: 'project-fact-added',
    projectId: sug.project_id,
    fact: enrichFactWithSourceChatTitle(fact),
  });
  wsHub.broadcastAll({ type: 'project-fact-suggestion-removed', chatId, suggestionId: sid });
  void compactProjectFacts(sug.project_id).catch(() => {});
  res.type('application/json').json({ fact });
});

chatsRouter.post('/:id/fact-suggestions/:suggestionId/reject', (req, res) => {
  const chatId = Number(req.params.id);
  const sid = Number(req.params.suggestionId);
  if (!Number.isFinite(chatId) || !Number.isFinite(sid)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const sug = projectFactSuggestions.get(sid);
  if (!sug || sug.chat_id !== chatId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  projectFactSuggestions.remove(sid);
  wsHub.broadcastAll({ type: 'project-fact-suggestion-removed', chatId, suggestionId: sid });
  res.type('application/json').json({ ok: true });
});

/* ---------------- project skill suggestions (inbox-gated) ---------------- */

function parseTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const tags = raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  return tags.length > 0 ? tags : null;
}

/** Pending project-skill suggestions for this chat (JSON, includes full bodies). */
chatsRouter.get('/:id/skill-suggestions', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const suggestions = projectSkillSuggestions.listByChat(id);
  const first = suggestions[0];
  const projectName =
    first != null ? (projects.get(first.project_id)?.name?.trim() ?? 'project') : null;
  res.type('application/json').json({ suggestions, projectName });
});

chatsRouter.post('/:id/skill-suggestions/:suggestionId/accept', (req, res) => {
  const chatId = Number(req.params.id);
  const sid = Number(req.params.suggestionId);
  if (!Number.isFinite(chatId) || !Number.isFinite(sid)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const chat = chats.get(chatId);
  const sug = projectSkillSuggestions.get(sid);
  if (!chat || !sug || sug.chat_id !== chatId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!chat.project_id || chat.project_id !== sug.project_id) {
    res.status(400).json({ error: 'project mismatch' });
    return;
  }

  // Optional user edits submitted alongside the accept.
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name : sug.name;
  const description =
    typeof req.body?.description === 'string' && req.body.description.trim()
      ? req.body.description
      : sug.description;
  const body = typeof req.body?.body === 'string' && req.body.body.trim() ? req.body.body : sug.body;
  const tags = parseTags(req.body?.tags) ?? (sug.tags ? (JSON.parse(sug.tags) as string[]) : null);
  const scope = req.body?.scope === 'global' ? 'global' : 'project';
  const projectId = scope === 'global' ? null : sug.project_id;

  try {
    if (sug.kind === 'patch' && sug.target_skill_id != null && projectSkills.get(sug.target_skill_id)) {
      projectSkills.update(sug.target_skill_id, { name, description, body, tags });
      const updated = projectSkills.get(sug.target_skill_id)!;
      projectSkillSuggestions.remove(sid);
      wsHub.broadcastAll({
        type: 'project-skill-updated',
        projectId: updated.project_id ?? sug.project_id,
        skill: enrichSkillWithSourceChatTitle(updated),
      });
      wsHub.broadcastAll({ type: 'project-skill-suggestion-removed', chatId, suggestionId: sid });
      res.type('application/json').json({ skill: updated });
      return;
    }

    // 'new' (or a patch whose target vanished). Same-scope name collision →
    // treat as an update of the existing skill rather than a duplicate insert.
    const existing = projectSkills.getByName(projectId, name);
    if (existing) {
      projectSkills.update(existing.id, { name, description, body, tags });
      const updated = projectSkills.get(existing.id)!;
      projectSkillSuggestions.remove(sid);
      wsHub.broadcastAll({
        type: 'project-skill-updated',
        projectId: updated.project_id ?? sug.project_id,
        skill: enrichSkillWithSourceChatTitle(updated),
      });
      wsHub.broadcastAll({ type: 'project-skill-suggestion-removed', chatId, suggestionId: sid });
      res.type('application/json').json({ skill: updated });
      return;
    }

    const skill = projectSkills.create({
      projectId,
      name,
      description,
      body,
      tags,
      sourceChatId: chatId,
    });
    projectSkillSuggestions.remove(sid);
    wsHub.broadcastAll({
      type: 'project-skill-added',
      projectId: skill.project_id ?? sug.project_id,
      skill: enrichSkillWithSourceChatTitle(skill),
    });
    wsHub.broadcastAll({ type: 'project-skill-suggestion-removed', chatId, suggestionId: sid });
    res.type('application/json').json({ skill });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'accept failed' });
  }
});

chatsRouter.post('/:id/skill-suggestions/:suggestionId/reject', (req, res) => {
  const chatId = Number(req.params.id);
  const sid = Number(req.params.suggestionId);
  if (!Number.isFinite(chatId) || !Number.isFinite(sid)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const sug = projectSkillSuggestions.get(sid);
  if (!sug || sug.chat_id !== chatId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  projectSkillSuggestions.remove(sid);
  wsHub.broadcastAll({ type: 'project-skill-suggestion-removed', chatId, suggestionId: sid });
  res.type('application/json').json({ ok: true });
});

chatsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const chat = chats.get(id);
    if (!chat) {
      // Stale link / deleted chat → send the user home instead of a dead-end
      // 404 page. Keeps navigation friendly for non-technical users.
      res.redirect('/');
      return;
    }
    if (chats.markRead(id)) wsHub.broadcastAll({ type: 'chat-read', chatId: id });
    const { agents, error: agentsError } = await getAgentsSafe();
    const chatMessages = messages.listByChat(id);
    // The chat's "current" composer mode. Prefer the explicitly persisted
    // chats.mode (set the moment the user picks a mode — survives navigation and
    // syncs across devices). Fall back to the most recent message's mode for
    // legacy chats that predate the column, then to the UI default (empty string).
    let chatCurrentMode = '';
    if (chat.mode && isSelectableMode(chat.mode) && !isEphemeralMode(chat.mode as ChatMode)) {
      chatCurrentMode = chat.mode;
    } else {
      // Only USER rows carry a user-chosen mode. Assistant rows mirror it, but
      // synthetic system rows (e.g. the "saved X% tokens" savings badge) default
      // to 'execute' — and being the newest rows they'd otherwise hijack this
      // fallback, reopening a Work chat as Full Power. Walk back to the last
      // user message instead.
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== 'user') continue;
        const m = chatMessages[i].mode;
        if (m && isSelectableMode(m) && !isEphemeralMode(m as ChatMode)) {
          chatCurrentMode = m;
          break;
        }
      }
    }
    res.render('chat', {
      chats: chats.list(),
      allProjects: projects.list(),
      hasAnyTasks: tasks.hasAny(),
      taskStatusSignals: tasks.statusSignals(),
      activeChat: chat,
      chatMessages,
      agents,
      agentsError,
      defaultAgent: DEFAULT_AGENT,
      openclawBaseUrl: openclaw.baseUrl,
      cloudShareBaseUrl,
      workingIds: chatStatus.workingIds(),
      isWorking: chatStatus.isWorking(id),
      currentActivity: chatStatus.getActivity(id),
      scheduledList: scheduledMessages.listByChat(id),
      queueList: queuedMessages.listByChat(id),
      sendHintShow: shouldShowSendHint(),
      chatModes: listComposerModes(),
      defaultChatMode: defaultComposerMode(),
      chatCurrentMode,
      sttEnabled: openRouterEnabled(),
      // Lets the composer lock the runtime modes (and the connect chooser fire)
      // when no key is configured.
      openRouterReady: openRouterEnabled(),
      // Full Power (Execute) needs the gateway; agents.list succeeding implies it's
      // reachable. Seeds the composer's Full Power gating (no badge on this page).
      gatewayOk: !agentsError,
    });
  } catch (err) {
    next(err);
  }
});

chatsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const title = String(req.body?.title ?? '').trim();
  if (!title) {
    res.status(400).json({ error: 'title required' });
    return;
  }
  chats.rename(id, title, { manual: true });
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    title,
  });
  res.json({ id, title });
});

chatsRouter.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const next = String(req.body?.title ?? '').trim() || 'New chat';
  chats.rename(id, next, { manual: true });
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    title: next,
  });
  res.redirect(`/chats/${id}`);
});

chatsRouter.post('/:id/agent', (req, res) => {
  const id = Number(req.params.id);
  const agent = String(req.body?.agent ?? '').trim();
  if (agent) {
    chats.setAgent(id, agent);
    wsHub.broadcastAll({
      type: 'chat-updated',
      chatId: id,
      agent,
      updatedAt: chats.get(id)!.updated_at,
    });
  }
  res.redirect(`/chats/${id}`);
});

chatsRouter.post('/:id/shares', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).send('chat not found');
    return;
  }
  // checkbox sends "1" when checked, nothing when unchecked
  const shares = !!req.body?.shares;
  chats.setSharesToProject(id, shares);
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    sharesToProject: shares,
    updatedAt: chats.get(id)!.updated_at,
  });
  res.redirect(`/chats/${id}`);
});

// Persist the chat's sticky composer send-mode the moment the user picks it, so it
// survives navigation and syncs across devices instead of living only in this
// browser's localStorage. Pure iClaw UI state — the mode rides along with each
// sent message, so there's no gateway patch to make here.
chatsRouter.post('/:id/mode', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const raw = String(req.body?.mode ?? '').trim().toLowerCase();
  // Only persist real, selectable, non-ephemeral modes — incognito is transient.
  if (!isSelectableMode(raw) || isEphemeralMode(raw as ChatMode)) {
    res.status(400).json({ error: 'invalid mode' });
    return;
  }
  chats.setChatMode(id, raw);
  // A draft is hidden from the sidebar until its first user message. The client
  // upserts a sidebar row on any `updatedAt`, so omit it for drafts — otherwise
  // switching mode would leak the empty draft into the list. `mode` still
  // broadcasts for cross-tab sync.
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    mode: raw,
    ...(chats.isDraft(id) ? {} : { updatedAt: chats.get(id)!.updated_at }),
  });
  res.json({ id, mode: raw });
});

chatsRouter.post('/:id/unread', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  chats.forceUnread(id);
  wsHub.broadcastAll({ type: 'chat-unread', chatId: id });
  res.json({ ok: true });
});

chatsRouter.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const chat = chats.get(id);
  if (chat?.openclaw_session_id?.startsWith('agent:')) {
    // Tell the gateway too — otherwise the underlying OpenClaw session row
    // and its transcript on disk linger after the iClaw chat is gone.
    // Failures here are non-fatal: we still drop the local row and broadcast
    // the deletion so the UI doesn't get stuck on a gateway hiccup.
    try {
      await openclawWs.deleteSession(chat.openclaw_session_id);
    } catch (err) {
      console.warn(
        '[chats] sessions.delete failed for chat',
        id,
        err instanceof Error ? err.message : err,
      );
    }
  }
  chats.remove(id);
  wsHub.broadcastAll({ type: 'chat-deleted', chatId: id });
  res.redirect('/');
});

/**
 * Force-clear a stuck "working" flag. Use when a turn errored in a way that
 * didn't unwind the in-memory lock (e.g. agent crashed mid-stream). Doesn't
 * touch any data — only the in-process chatStatus map.
 */
chatsRouter.post('/:id/unstick', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const changed = chatStatus.forceClear(id);
  // Tell anyone subscribed that the turn is done — so the UI clears its
  // streaming placeholder.
  wsHub.broadcastToChat(id, {
    type: 'turn-error',
    chatId: id,
    error: 'Turn was force-unstuck.',
  });
  res.json({ id, cleared: changed });
});

chatsRouter.get('/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  res.json(messages.listByChat(id));
});

/**
 * Redact a substring in an existing message: store a new project secret and
 * replace the selection with `[[iclaw:secret:…]]` in the transcript.
 */
chatsRouter.post('/:id/messages/:messageId/redact-secret', (req, res) => {
  const chatId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  const chat = chats.get(chatId);
  const row = messages.get(messageId);
  if (!chat || !row || row.chat_id !== chatId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (row.role !== 'user' && row.role !== 'assistant') {
    res.status(400).json({ error: 'only user and assistant messages can be redacted' });
    return;
  }
  const label = String(req.body?.label ?? '');
  const selection = String(req.body?.selection ?? '');
  try {
    const redacted = redactSelectionInMessageContent({
      content: row.content,
      selection,
      label,
      projectId: chat.project_id,
      sourceChatId: chatId,
      sourceMessageId: messageId,
    });
    const updated = messages.updateContent(messageId, redacted.content);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const secret = projectSecrets.get(redacted.secretId);
    if (secret) {
      wsHub.broadcastAll({
        type: 'project-secret-added',
        projectId: secret.project_id,
        secret: {
          id: secret.id,
          label: secret.label,
          created_at: secret.created_at,
          value_length: secret.value.length,
        },
      });
    }
    wsHub.broadcastToChat(chatId, {
      type: 'message-updated',
      chatId,
      message: updated,
    });
    res.json({
      message: updated,
      secret: secret
        ? { id: secret.id, label: secret.label, value_length: secret.value.length }
        : { id: redacted.secretId },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'redact' });
  }
});

/** Composer attach menu — metadata only. */
chatsRouter.get('/:id/secrets/picker', (req, res) => {
  const chatId = Number(req.params.id);
  const chat = chats.get(chatId);
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  res.json(projectSecrets.listForComposerPickerForChat(chat));
});

/** Whether a secret name is free app-wide (composer modal validation). */
chatsRouter.get('/:id/secrets/check-label', (req, res) => {
  const chatId = Number(req.params.id);
  if (!chats.get(chatId)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const label = String(req.query.label ?? '');
  res.json({ available: projectSecrets.isLabelAvailable(label) });
});

/** Map a secret to a row usable in this chat's transcript. */
chatsRouter.post('/:id/secrets/:secretId/use-in-chat', (req, res) => {
  const chatId = Number(req.params.id);
  const secretId = Number(req.params.secretId);
  const chat = chats.get(chatId);
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  try {
    const row = projectSecrets.resolveForChat(
      { chatId: chat.id, projectId: chat.project_id },
      secretId,
    );
    res.json({
      id: row.id,
      label: row.label,
      value_length: row.value.length,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'secret' });
  }
});

/** Reveal one secret value (same-origin; must be usable in this chat). */
chatsRouter.get('/:id/secrets/:secretId/value', (req, res) => {
  const chatId = Number(req.params.id);
  const secretId = Number(req.params.secretId);
  const chat = chats.get(chatId);
  const sec = projectSecrets.get(secretId);
  if (!chat || !sec || !secretUsableInChat(sec, chat)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('application/json').json({ value: sec.value });
});

/**
 * List secrets actually referenced from this chat's transcript. Used by the
 * cloud-share modal so the user can pick which to include in plaintext.
 * Each row carries metadata only — no values. Sorted by occurrence desc.
 */
chatsRouter.get('/:id/secrets/in-chat', (req, res) => {
  const chatId = Number(req.params.id);
  const chat = chats.get(chatId);
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  // Walk the transcript once, tally placeholders by secret id.
  const occurrences = new Map<number, number>();
  const PH = /\[\[iclaw:secret:(\d+)\|/g;
  const rows = messages.listByChat(chatId);
  for (const m of rows) {
    if (typeof m.content !== 'string') continue;
    PH.lastIndex = 0;
    let match;
    while ((match = PH.exec(m.content)) !== null) {
      const id = Number(match[1]);
      if (!Number.isFinite(id)) continue;
      occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    }
    if (typeof m.reply_quote === 'string') {
      PH.lastIndex = 0;
      while ((match = PH.exec(m.reply_quote)) !== null) {
        const id = Number(match[1]);
        if (!Number.isFinite(id)) continue;
        occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
      }
    }
  }
  // Hydrate label + length for each referenced id. Cross-project references
  // (a placeholder that points at a secret from a different project — should
  // not happen but guard anyway) are excluded.
  const result: Array<{
    id: number;
    label: string;
    length: number;
    occurrences: number;
  }> = [];
  for (const [id, count] of occurrences) {
    const sec = projectSecrets.get(id);
    if (!sec) continue;
    if (!secretUsableInChat(sec, chat)) continue;
    result.push({
      id: sec.id,
      label: sec.label,
      length: sec.value.length,
      occurrences: count,
    });
  }
  result.sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label));
  res.json({ secrets: result });
});

// ---------- composer queue (persisted waiting messages) ----------

function parseInlineSecretsBody(body: unknown): InlineSecretWire[] | undefined {
  if (!Array.isArray(body)) return undefined;
  return (body as unknown[])
    .map((x): InlineSecretWire | null => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const slot = Number(o.slot);
      if (!Number.isFinite(slot)) return null;
      return { slot, label: String(o.label ?? ''), plain: String(o.plain ?? '') };
    })
    .filter((x): x is InlineSecretWire => x != null);
}

function parseReplyToBody(
  body: unknown,
): { messageId: number; quote: string; role?: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  const messageId = Number(o.messageId);
  const quote = String(o.quote ?? '').trim();
  if (!Number.isFinite(messageId) || !quote) return undefined;
  const role = o.role != null ? String(o.role) : undefined;
  return { messageId, quote, role };
}

function parseIncomingAttachmentsBody(body: unknown): IncomingAttachment[] | undefined {
  if (!Array.isArray(body)) return undefined;
  return body as IncomingAttachment[];
}

/** List pending queue rows for this chat (also used to hydrate after navigation). */
chatsRouter.get('/:id/queue', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  res.json({ queue: queuedMessages.listByChat(id) });
});

/**
 * Enqueue a user message while a turn is still running.
 * Body mirrors WS `send`: content, replyTo?, attachments?, inlineSecrets?
 */
chatsRouter.post('/:id/queue', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const content = String(req.body?.content ?? '').trim();
  const incoming = parseIncomingAttachmentsBody(req.body?.attachments);
  const hasAttachments = incoming && incoming.length > 0;
  if (!content && !hasAttachments) {
    res.status(400).json({ error: 'content or attachments required' });
    return;
  }
  const inlineSecrets = parseInlineSecretsBody(req.body?.inlineSecrets);
  if (/\[\[iclaw:s\d+\]\]/.test(content)) {
    if (!inlineSecrets?.length) {
      res.status(400).json({ error: 'inlineSecrets required for secret markers' });
      return;
    }
  } else if (inlineSecrets && inlineSecrets.length > 0) {
    res.status(400).json({ error: 'inlineSecrets without [[iclaw:sN]] markers' });
    return;
  }
  let persistedAttachments = null;
  try {
    if (hasAttachments) {
      persistedAttachments = persistIncomingAttachments(id, incoming).map((p) => p.persisted);
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'attachments' });
    return;
  }
  const replyTo = parseReplyToBody(req.body?.replyTo);
  try {
    const row = queuedMessages.create({
      chatId: id,
      content,
      replyTo: replyTo ?? null,
      attachments: persistedAttachments,
      inlineSecrets: inlineSecrets ?? null,
      mode: normalizeChatMode(req.body?.mode),
    });
    wsHub.broadcastAll({ type: 'queue-added', chatId: id, item: row });
    res.json({ item: row });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : 'failed to enqueue' });
  }
});

chatsRouter.post('/:id/queue/:queueId/delete', (req, res) => {
  const id = Number(req.params.id);
  const qid = Number(req.params.queueId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const row = queuedMessages.get(qid);
  if (!row || row.chat_id !== id) {
    res.status(404).json({ error: 'queued message not found' });
    return;
  }
  queuedMessages.remove(qid);
  wsHub.broadcastAll({ type: 'queue-deleted', chatId: id, queueId: qid });
  res.json({ ok: true });
});

/** Move a queued row to the front (interrupt current turn, then flush it). */
chatsRouter.post('/:id/queue/:queueId/promote', (req, res) => {
  const id = Number(req.params.id);
  const qid = Number(req.params.queueId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const updated = queuedMessages.promoteToFront(id, qid);
  if (!updated) {
    res.status(404).json({ error: 'queued message not found' });
    return;
  }
  const queue = queuedMessages.listByChat(id);
  wsHub.broadcastAll({ type: 'queue-reordered', chatId: id, queue });
  res.json({ queue });
});

/** Dispatch one queued row through the normal send/turn pipeline. */
chatsRouter.post('/:id/queue/:queueId/flush', async (req, res) => {
  const id = Number(req.params.id);
  const qid = Number(req.params.queueId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const row = queuedMessages.getForFlush(qid);
  if (!row || row.chat_id !== id) {
    res.status(404).json({ error: 'queued message not found' });
    return;
  }
  queuedMessages.remove(qid);
  wsHub.broadcastAll({ type: 'queue-deleted', chatId: id, queueId: qid });
  const replyTo =
    row.reply_to_message_id != null && row.reply_quote
      ? {
          messageId: row.reply_to_message_id,
          quote: row.reply_quote,
          ...(row.reply_to_role ? { role: row.reply_to_role } : {}),
        }
      : undefined;
  try {
    await sendMessage({
      chatId: id,
      content: row.content,
      replyTo,
      inlineSecrets: row.inline_secrets ?? undefined,
      prePersistedAttachments:
        row.attachments && row.attachments.length > 0 ? row.attachments : undefined,
      requestId: String(req.body?.requestId ?? '').trim() || undefined,
      mode: row.mode,
    });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'send failed' });
  }
});

// ---------- scheduled messages (Telegram-style "send later") ----------

const SCHEDULE_MIN_LEAD_MS = 3 * 60_000;

function scheduleAtValidationError(when: Date): string | null {
  if (when.getTime() < Date.now() + SCHEDULE_MIN_LEAD_MS) {
    return 'scheduledAt must be at least 3 minutes in the future';
  }
  return null;
}

/** List everything still pending for this chat. Used to hydrate the banner. */
chatsRouter.get('/:id/scheduled', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  res.json({ scheduled: scheduledMessages.listByChat(id) });
});

/**
 * Queue a message to fire at a specific UTC instant.
 *
 * Body: { content: string, scheduledAt: ISO string, inlineSecrets?: { slot, label, plain }[] }
 *
 * The scheduler service picks up rows where `scheduled_at <= datetime('now')`
 * on every tick and dispatches them through `sendMessage` as if the user had
 * just hit Send — so persistence, broadcasts, and project-context injection
 * all behave identically.
 */
chatsRouter.post('/:id/scheduled', (req, res) => {
  const id = Number(req.params.id);
  const chat = chats.get(id);
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  const rawAt = String(req.body?.scheduledAt ?? '').trim();
  if (!rawAt) {
    res.status(400).json({ error: 'scheduledAt required' });
    return;
  }
  const when = new Date(rawAt);
  if (Number.isNaN(when.getTime())) {
    res.status(400).json({ error: 'invalid scheduledAt' });
    return;
  }
  const scheduleAtErr = scheduleAtValidationError(when);
  if (scheduleAtErr) {
    res.status(400).json({ error: scheduleAtErr });
    return;
  }
  let inlineSecrets: InlineSecretWire[] | undefined;
  if (Array.isArray(req.body?.inlineSecrets)) {
    inlineSecrets = (req.body.inlineSecrets as unknown[])
      .map((x): InlineSecretWire | null => {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const slot = Number(o.slot);
        if (!Number.isFinite(slot)) return null;
        return { slot, label: String(o.label ?? ''), plain: String(o.plain ?? '') };
      })
      .filter((x): x is InlineSecretWire => x != null);
  }
  let toStore = content;
  if (/\[\[iclaw:s\d+\]\]/.test(content)) {
    try {
      const resolved = resolveInlineSecretMarkersInContent({
        content,
        inlineSecrets,
        projectId: chat.project_id,
        sourceChatId: id,
      });
      toStore = resolved.storedContent;
      for (const sid of resolved.newSecretIds) {
        const row = projectSecrets.get(sid);
        if (row) {
          wsHub.broadcastAll({
            type: 'project-secret-added',
            projectId: row.project_id,
            secret: {
              id: row.id,
              label: row.label,
              created_at: row.created_at,
              value_length: row.value.length,
            },
          });
        }
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'secrets' });
      return;
    }
  } else if (inlineSecrets && inlineSecrets.length > 0) {
    res.status(400).json({ error: 'inlineSecrets without [[iclaw:sN]] markers' });
    return;
  }
  try {
    const row = scheduledMessages.create({ chatId: id, content: toStore, scheduledAt: when });
    wsHub.broadcastAll({
      type: 'scheduled-added',
      chatId: id,
      scheduled: row,
    });
    res.json({ scheduled: row });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : 'failed to schedule' });
  }
});

chatsRouter.post('/:id/scheduled/:scheduledId/delete', (req, res) => {
  const id = Number(req.params.id);
  const sid = Number(req.params.scheduledId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const row = scheduledMessages.get(sid);
  if (!row || row.chat_id !== id) {
    res.status(404).json({ error: 'scheduled message not found' });
    return;
  }
  scheduledMessages.remove(sid);
  wsHub.broadcastAll({
    type: 'scheduled-deleted',
    chatId: id,
    scheduledId: sid,
  });
  res.json({ ok: true });
});

/** Fire a pending scheduled message immediately (same path as the sweeper). */
chatsRouter.post('/:id/scheduled/:scheduledId/send-now', async (req, res) => {
  const id = Number(req.params.id);
  const sid = Number(req.params.scheduledId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const row = scheduledMessages.get(sid);
  if (!row || row.chat_id !== id) {
    res.status(404).json({ error: 'scheduled message not found' });
    return;
  }
  scheduledMessages.remove(sid);
  wsHub.broadcastAll({
    type: 'scheduled-deleted',
    chatId: id,
    scheduledId: sid,
  });
  try {
    await sendMessage({ chatId: id, content: row.content });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'send failed' });
  }
});

/**
 * Update content and/or `scheduledAt` on a pending row.
 * Body: { content?: string, scheduledAt?: ISO string }
 */
chatsRouter.patch('/:id/scheduled/:scheduledId', (req, res) => {
  const id = Number(req.params.id);
  const sid = Number(req.params.scheduledId);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const row = scheduledMessages.get(sid);
  if (!row || row.chat_id !== id) {
    res.status(404).json({ error: 'scheduled message not found' });
    return;
  }
  const patch: { content?: string; scheduledAt?: string | Date } = {};
  if (req.body?.content !== undefined) {
    const content = String(req.body.content).trim();
    if (!content) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    patch.content = content;
  }
  if (req.body?.scheduledAt !== undefined) {
    const rawAt = String(req.body.scheduledAt).trim();
    const when = new Date(rawAt);
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: 'invalid scheduledAt' });
      return;
    }
    const scheduleAtErr = scheduleAtValidationError(when);
    if (scheduleAtErr) {
      res.status(400).json({ error: scheduleAtErr });
      return;
    }
    patch.scheduledAt = when;
  }
  if (patch.content === undefined && patch.scheduledAt === undefined) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }
  try {
    const updated = scheduledMessages.update(sid, patch);
    if (!updated) {
      res.status(404).json({ error: 'scheduled message not found' });
      return;
    }
    wsHub.broadcastAll({
      type: 'scheduled-updated',
      chatId: id,
      scheduled: updated,
    });
    res.json({ scheduled: updated });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : 'failed to update' });
  }
});

/** GET /chats/:id/workspace-info — workspace size for Work/Secure Mode. */
chatsRouter.get('/:id/workspace-info', async (req, res) => {
  const chatId = Number(req.params.id);
  const sessionId = getWorkSessionId(chatId);
  if (!sessionId) return res.json({ active: false });
  const info = await getWorkspaceInfo(sessionId);
  res.json({ active: true, sessionId, ...info });
});

/**
 * POST /chats/:id/destroy-workspace — tear down the chat's Safe/Work sandbox:
 * stops the container and deletes the workspace (the Safe-mode copy and all of
 * its contents). The next message starts a fresh sandbox.
 */
chatsRouter.post('/:id/destroy-workspace', async (req, res) => {
  const chatId = Number(req.params.id);
  if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'bad chat id' });
  const destroyed = await destroyWorkSession(chatId);
  res.json({ destroyed });
});

/** POST /chats/:id/export-sandbox — copy the Safe sandbox out to a host folder. */
chatsRouter.post('/:id/export-sandbox', async (req, res) => {
  const chatId = Number(req.params.id);
  if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'bad chat id' });
  const destDir = typeof req.body?.destDir === 'string' ? req.body.destDir : undefined;
  try {
    const result = await exportChatSandbox(chatId, destDir);
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /chats/:id/apply-sandbox — apply the sandbox's changes to the originals. */
chatsRouter.post('/:id/apply-sandbox', async (req, res) => {
  const chatId = Number(req.params.id);
  if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'bad chat id' });
  try {
    const results = await applyChatSandboxChanges(chatId);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
