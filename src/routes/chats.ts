import { Router } from 'express';
import {
  chats,
  messages,
  chatSearch,
  projects,
  projectFactSuggestions,
  projectFacts,
  projectSecrets,
  secretUsableInChat,
  scheduledMessages,
  enrichFactWithSourceChatTitle,
} from '../services/store';
import { resolveInlineSecretMarkersInContent } from '../services/inlineSecrets';
import type { InlineSecretWire } from '../services/inlineSecrets';
import { compactProjectFacts } from '../services/projectMemory';
import { openclawWs } from '../services/openclawWs';
import { openclaw, cloudShareBaseUrl } from '../services/openclaw';
import { chatStatus } from '../services/chatStatus';
import { wsHub } from '../services/wsHub';

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

chatsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const chat = chats.get(id);
    if (!chat) {
      res.status(404).send('chat not found');
      return;
    }
    if (chats.markRead(id)) wsHub.broadcastAll({ type: 'chat-read', chatId: id });
    const { agents, error: agentsError } = await getAgentsSafe();
    res.render('chat', {
      chats: chats.list(),
      allProjects: projects.list(),
      activeChat: chat,
      chatMessages: messages.listByChat(id),
      agents,
      agentsError,
      defaultAgent: DEFAULT_AGENT,
      openclawBaseUrl: openclaw.baseUrl,
      cloudShareBaseUrl,
      workingIds: chatStatus.workingIds(),
      isWorking: chatStatus.isWorking(id),
      currentActivity: chatStatus.getActivity(id),
      scheduledList: scheduledMessages.listByChat(id),
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
    updatedAt: chats.get(id)!.updated_at,
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
    updatedAt: chats.get(id)!.updated_at,
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

/**
 * Toggle reasoning visibility on the active session by sending the slash
 * command through the normal chat flow. The mode is mirrored locally so the
 * UI toggle stays in sync across reloads.
 */
chatsRouter.post('/:id/reasoning', async (req, res) => {
  const id = Number(req.params.id);
  const chat = chats.get(id);
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  const raw = String(req.body?.mode ?? '').trim().toLowerCase();
  const mode: 'off' | 'on' | 'stream' =
    raw === 'on' ? 'on' : raw === 'stream' ? 'stream' : 'off';
  // Mirror locally first — UI source of truth even if the gateway hiccups.
  chats.setReasoningMode(id, mode);
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    reasoningMode: mode,
    updatedAt: chats.get(id)!.updated_at,
  });
  // Push the real flip to OpenClaw. `sessions.patch` is the proper channel —
  // it's what the dashboard uses. Failure here doesn't roll back the mirror;
  // we surface the error to the caller so the UI can warn.
  let gatewayWarning: string | null = null;
  try {
    await openclawWs.patchSession({
      sessionKey: chat.openclaw_session_id,
      reasoningLevel: mode === 'off' ? null : mode,
    });
  } catch (err) {
    gatewayWarning = err instanceof Error ? err.message : String(err);
  }
  res.json({ id, mode, ...(gatewayWarning ? { gatewayWarning } : {}) });
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

// ---------- scheduled messages (Telegram-style "send later") ----------

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
  // Allow scheduling for "now" or even slightly in the past — the next sweep
  // will fire it. This also covers clock skew between browser and server.
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
