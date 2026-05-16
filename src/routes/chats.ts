import { Router } from 'express';
import { chats, messages, chatSearch } from '../services/store';
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
      activeChat: chat,
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
  wsHub.broadcastAll({ type: 'chat-updated', chatId: id, title });
  res.json({ id, title });
});

chatsRouter.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const next = String(req.body?.title ?? '').trim() || 'New chat';
  chats.rename(id, next, { manual: true });
  wsHub.broadcastAll({ type: 'chat-updated', chatId: id, title: next });
  res.redirect(`/chats/${id}`);
});

chatsRouter.post('/:id/agent', (req, res) => {
  const id = Number(req.params.id);
  const agent = String(req.body?.agent ?? '').trim();
  if (agent) {
    chats.setAgent(id, agent);
    wsHub.broadcastAll({ type: 'chat-updated', chatId: id, agent });
  }
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
