import { Router, type Request, type Response } from 'express';
import { chats, messages } from '../services/store';
import { openclaw, type ChatMessage } from '../services/openclaw';
import { chatStatus } from '../services/chatStatus';
import { beginSse, endSse, writeSse, type ClientStreamEvent } from '../services/sse';
import { gatewayWs, type GatewayActivity } from '../services/gatewayWs';
import { lifecycleActivityLabel, toolActivityLabel } from '../services/toolLabels';
import type { Message } from '../types';

export const chatsRouter: Router = Router();

const DEFAULT_AGENT = 'openclaw/default';

function wantsStream(req: Request): boolean {
  return req.headers.accept?.includes('text/event-stream') ?? false;
}

async function getAgentsSafe(): Promise<{ agents: { id: string }[]; error: string | null }> {
  try {
    return { agents: await openclaw.listAgents(), error: null };
  } catch (err) {
    return { agents: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function historyForChat(chatId: number): ChatMessage[] {
  return messages
    .listByChat(chatId)
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => ({ role: m.role as ChatMessage['role'], content: m.content }));
}

function gatewayActivityToSse(ev: GatewayActivity): ClientStreamEvent | null {
  if (ev.kind === 'tool') {
    return {
      type: 'tool',
      phase: ev.phase,
      name: ev.name,
      label: toolActivityLabel(ev.name),
    };
  }
  if (ev.kind === 'status') {
    return { type: 'status', status: 'thinking' };
  }
  if (ev.kind === 'lifecycle') {
    return {
      type: 'lifecycle',
      phase: ev.phase,
      label: lifecycleActivityLabel(ev.phase),
    };
  }
  return null;
}

async function runOpenClawStream(
  res: Response,
  opts: { model: string; sessionKey: string; messages: ChatMessage[] },
): Promise<{ content: string; finishReason: string | null }> {
  writeSse(res, { type: 'status', status: 'thinking' });

  await gatewayWs.ensureConnected();

  const unwatch = gatewayWs.watchSession(opts.sessionKey, (activity) => {
    const sse = gatewayActivityToSse(activity);
    if (sse) writeSse(res, sse);
  });

  let content = '';
  let finishReason: string | null = null;

  try {
    for await (const ev of openclaw.chatStream({
      model: opts.model,
      sessionKey: opts.sessionKey,
      messages: opts.messages,
    })) {
      if (ev.type === 'delta') {
        content += ev.text;
        writeSse(res, { type: 'delta', text: ev.text });
      } else if (ev.type === 'tool') {
        writeSse(res, {
          type: 'tool',
          phase: ev.phase,
          name: ev.name,
          label: toolActivityLabel(ev.name),
        });
      } else if (ev.type === 'finish') {
        finishReason = ev.reason;
      }
    }
  } finally {
    unwatch();
  }

  return { content, finishReason };
}

function streamError(res: Response, err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  if (!res.headersSent) beginSse(res);
  writeSse(res, { type: 'error', error });
  endSse(res);
}

// POST /chats — create a chat AND run the first turn atomically.
chatsRouter.post('/', async (req, res, next) => {
  const content = String(req.body?.content ?? '').trim();
  const agent = String(req.body?.agent ?? '').trim() || DEFAULT_AGENT;
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }

  const chat = chats.create(agent);

  if (!wantsStream(req)) {
    try {
      const reply = await chatStatus.withLock(chat.id, async () => {
        messages.append(chat.id, 'user', content);
        const result = await openclaw.chat({
          model: chat.agent,
          sessionKey: chat.openclaw_session_id,
          messages: [{ role: 'user', content }],
        });
        return messages.append(chat.id, 'assistant', result.content, result.finish_reason);
      });
      res.json({ id: chat.id, message: reply });
    } catch (err) {
      next(err);
    }
    return;
  }

  beginSse(res);
  try {
    await chatStatus.withLock(chat.id, async () => {
      messages.append(chat.id, 'user', content);
      const { content: reply, finishReason } = await runOpenClawStream(res, {
        model: chat.agent,
        sessionKey: chat.openclaw_session_id,
        messages: [{ role: 'user', content }],
      });
      const stored = messages.append(chat.id, 'assistant', reply, finishReason);
      writeSse(res, { type: 'done', id: chat.id, message: stored });
    });
    endSse(res);
  } catch (err) {
    streamError(res, err);
  }
});

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

  if (!wantsStream(req)) {
    try {
      const stored = await chatStatus.withLock(id, async () => {
        const fresh = chats.get(id)!;
        messages.append(id, 'user', content);
        const result = await openclaw.chat({
          model: fresh.agent,
          sessionKey: fresh.openclaw_session_id,
          messages: historyForChat(id),
        });
        return messages.append(id, 'assistant', result.content, result.finish_reason);
      });
      res.json(stored);
    } catch (err) {
      next(err);
    }
    return;
  }

  beginSse(res);
  try {
    await chatStatus.withLock(id, async () => {
      const fresh = chats.get(id)!;
      messages.append(id, 'user', content);
      const { content: reply, finishReason } = await runOpenClawStream(res, {
        model: fresh.agent,
        sessionKey: fresh.openclaw_session_id,
        messages: historyForChat(id),
      });
      const stored: Message = messages.append(id, 'assistant', reply, finishReason);
      writeSse(res, { type: 'done', message: stored });
    });
    endSse(res);
  } catch (err) {
    streamError(res, err);
  }
});
