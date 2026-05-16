import { Router } from 'express';
import { chats, messages, chatSearch, projects, projectFactSuggestions, projectFacts } from '../services/store';
import { compactProjectFacts } from '../services/projectMemory';
import { openclaw } from '../services/openclaw';
import { openclawWs } from '../services/openclawWs';
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
    first != null ? (projects.get(first.project_id)?.name?.trim() ?? 'проєкт') : null;
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
  wsHub.broadcastAll({ type: 'project-fact-added', projectId: sug.project_id, fact });
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
    const activeProject = chat.project_id ? projects.get(chat.project_id) ?? null : null;
    res.render('chat', {
      chats: chats.list(),
      allProjects: projects.list(),
      activeChat: chat,
      activeProject,
      chatMessages: messages.listByChat(id),
      agents,
      agentsError,
      defaultAgent: DEFAULT_AGENT,
      openclawBaseUrl: openclaw.baseUrl,
      workingIds: chatStatus.workingIds(),
      isWorking: chatStatus.isWorking(id),
      currentActivity: chatStatus.getActivity(id),
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

chatsRouter.post('/:id/project', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).send('chat not found');
    return;
  }
  const raw = req.body?.projectId;
  let projectId: number | null = null;
  if (raw && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && projects.get(n)) projectId = n;
  }
  chats.setProject(id, projectId);
  const proj = projectId ? projects.get(projectId) : null;
  wsHub.broadcastAll({
    type: 'chat-updated',
    chatId: id,
    projectId,
    projectName: proj?.name ?? null,
    updatedAt: chats.get(id)!.updated_at,
  });
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

chatsRouter.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
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
