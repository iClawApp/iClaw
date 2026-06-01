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
  queuedMessages,
  tasks,
  enrichFactWithSourceChatTitle,
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
import { sendMessage } from '../services/chatRunner';
import {
  DEFAULT_MODE,
  listSelectableModes,
  normalizeChatMode,
} from '../services/chatModes';
import { shouldShowSendHint } from '../services/sendHint';

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
      hasAnyTasks: tasks.hasAny(),
      taskStatusSignals: tasks.statusSignals(),
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
      queueList: queuedMessages.listByChat(id),
      sendHintShow: shouldShowSendHint(),
      chatModes: listSelectableModes(),
      defaultChatMode: DEFAULT_MODE,
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
