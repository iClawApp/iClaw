import { Router } from 'express';
import { chats, messages } from '../services/store';
import { openclaw, type ChatMessage } from '../services/openclaw';
import { chatStatus } from '../services/chatStatus';

export const chatsRouter: Router = Router();

const DEFAULT_AGENT = 'openclaw/default';

async function getAgentsSafe(): Promise<{ agents: { id: string }[]; error: string | null }> {
  try {
    return { agents: await openclaw.listAgents(), error: null };
  } catch (err) {
    return { agents: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// POST /chats — create a chat AND run the first turn atomically.
// We don't create empty chats; a chat is only born when a real first message
// is sent. Returns JSON: { id, message } where `message` is the assistant reply.
chatsRouter.post('/', async (req, res, next) => {
  try {
    const content = String(req.body?.content ?? '').trim();
    const agent = String(req.body?.agent ?? '').trim() || DEFAULT_AGENT;
    if (!content) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    const chat = chats.create(agent);
    const reply = await chatStatus.withLock(chat.id, async () => {
      messages.append(chat.id, 'user', content);
      const history: ChatMessage[] = [{ role: 'user', content }];
      const result = await openclaw.chat({
        model: chat.agent,
        sessionKey: chat.openclaw_session_id,
        messages: history,
      });
      return messages.append(chat.id, 'assistant', result.content, result.finish_reason);
    });
    res.json({ id: chat.id, message: reply });
  } catch (err) {
    next(err);
  }
});

// IMPORTANT: register literal /status before /:id so it isn't captured.
chatsRouter.get('/status', (_req, res) => {
  res.json({ working: chatStatus.workingIds() });
});

chatsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const chat = chats.get(id);
    if (!chat) {
      res.status(404).send('chat not found');
      return;
    }
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
    });
  } catch (err) {
    next(err);
  }
});

chatsRouter.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  chats.rename(id, String(req.body?.title ?? ''));
  res.redirect(`/chats/${id}`);
});

chatsRouter.post('/:id/agent', (req, res) => {
  const id = Number(req.params.id);
  const agent = String(req.body?.agent ?? '').trim();
  if (agent) chats.setAgent(id, agent);
  res.redirect(`/chats/${id}`);
});

chatsRouter.post('/:id/delete', (req, res) => {
  chats.remove(Number(req.params.id));
  res.redirect('/');
});

// JSON API used by the chat client
chatsRouter.get('/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!chats.get(id)) {
    res.status(404).json({ error: 'chat not found' });
    return;
  }
  res.json(messages.listByChat(id));
});

chatsRouter.post('/:id/messages', async (req, res, next) => {
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

  try {
    const stored = await chatStatus.withLock(id, async () => {
      const fresh = chats.get(id)!;
      messages.append(id, 'user', content);

      const history: ChatMessage[] = messages
        .listByChat(id)
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        .map((m) => ({ role: m.role as ChatMessage['role'], content: m.content }));

      const result = await openclaw.chat({
        model: fresh.agent,
        sessionKey: fresh.openclaw_session_id,
        messages: history,
      });

      return messages.append(id, 'assistant', result.content, result.finish_reason);
    });
    res.json(stored);
  } catch (err) {
    next(err);
  }
});
