import { Router, type Request, type Response } from 'express';
import { chats, messages } from '../services/store';
import { openclaw, type ChatMessage } from '../services/openclaw';
import { chatStatus } from '../services/chatStatus';
import { beginSse, endSse, writeSse, type ClientStreamEvent } from '../services/sse';
import { gatewayWs, type GatewayActivity } from '../services/gatewayWs';
import { lifecycleActivityLabel, toolActivityLabel } from '../services/toolLabels';
import { deriveTitle, suggestChatTitleWithTimeout } from '../services/chatTitle';
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

/**
 * Fire-and-forget title suggestion. Runs as a background sub-request to OpenClaw
 * (~30s through the agent), independent of the main turn. When it resolves with
 * a quality-validated title, we write it to the DB and emit an SSE update so
 * the sidebar swaps the placeholder. If it fails or returns garbage, the
 * placeholder (truncated user message) stays.
 *
 * Returns a Promise that the caller awaits BEFORE emitting `done`, so the
 * final title is visible to the client when the turn completes.
 */
function backgroundTitleTask(
  res: Response,
  opts: { chatId: number; model: string; userMessage: string },
): Promise<void> {
  const chat = chats.get(opts.chatId);
  if (!chat || chat.title_manual) return Promise.resolve();

  return suggestChatTitleWithTimeout({
    model: opts.model,
    userMessage: opts.userMessage,
  }).then((suggested) => {
    if (!suggested) return;
    if (!chats.trySetAutoTitle(opts.chatId, suggested)) return;
    if (!res.writableEnded) {
      writeSse(res, { type: 'title', id: opts.chatId, title: suggested });
    }
  });
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
  opts: { chatId: number; model: string; sessionKey: string; messages: ChatMessage[] },
): Promise<{ content: string; finishReason: string | null }> {
  writeSse(res, { type: 'status', status: 'thinking' });
  chatStatus.setActivity(opts.chatId, { kind: 'thinking', label: 'Thinking…' });

  await gatewayWs.ensureConnected();

  const unwatch = gatewayWs.watchSession(opts.sessionKey, (activity) => {
    const sse = gatewayActivityToSse(activity);
    if (sse) writeSse(res, sse);

    // Mirror into chatStatus so a reloaded page can see the same label.
    if (activity.kind === 'tool') {
      if (activity.phase === 'start') {
        chatStatus.setActivity(opts.chatId, {
          kind: 'tool',
          name: activity.name,
          label: toolActivityLabel(activity.name),
        });
      }
      // tool 'end' alone doesn't change the activity — the next event
      // (another tool, lifecycle, or first text delta) will replace it.
    } else if (activity.kind === 'lifecycle') {
      chatStatus.setActivity(opts.chatId, {
        kind: 'lifecycle',
        phase: activity.phase,
        label: lifecycleActivityLabel(activity.phase),
      });
    } else if (activity.kind === 'status') {
      chatStatus.setActivity(opts.chatId, { kind: 'thinking', label: 'Thinking…' });
    }
  });

  let content = '';
  let finishReason: string | null = null;
  let switchedToGenerating = false;

  try {
    for await (const ev of openclaw.chatStream({
      model: opts.model,
      sessionKey: opts.sessionKey,
      messages: opts.messages,
    })) {
      if (ev.type === 'delta') {
        if (!switchedToGenerating) {
          switchedToGenerating = true;
          chatStatus.setActivity(opts.chatId, { kind: 'generating', label: 'Generating…' });
        }
        content += ev.text;
        writeSse(res, { type: 'delta', text: ev.text });
      } else if (ev.type === 'tool') {
        writeSse(res, {
          type: 'tool',
          phase: ev.phase,
          name: ev.name,
          label: toolActivityLabel(ev.name),
        });
        // The tool-call events from the chat stream are local-to-this-turn,
        // distinct from gatewayWs session events. Mirror them too.
        if (ev.phase === 'start') {
          chatStatus.setActivity(opts.chatId, {
            kind: 'tool',
            name: ev.name,
            label: toolActivityLabel(ev.name),
          });
        }
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

  // Seed a placeholder title so the chat is fully usable even if the AI title
  // task is slow / fails / gets rejected by quality gates.
  const placeholderTitle = deriveTitle(content);
  chats.trySetAutoTitle(chat.id, placeholderTitle);

  if (!wantsStream(req)) {
    try {
      const reply = await chatStatus.withLock(chat.id, async () => {
        messages.append(chat.id, 'user', content);
        const result = await openclaw.chat({
          model: chat.agent,
          sessionKey: chat.openclaw_session_id,
          messages: [{ role: 'user', content }],
        });
        return messages.append(
          chat.id,
          'assistant',
          result.content,
          result.finish_reason,
        );
      });
      res.json({
        id: chat.id,
        message: reply,
        title: chats.get(chat.id)?.title ?? placeholderTitle,
      });
    } catch (err) {
      next(err);
    }
    return;
  }

  beginSse(res);
  try {
    // Tell the client immediately: chat exists, here's a usable title. The
    // sidebar inserts the entry now; an AI-improved title may arrive later.
    writeSse(res, { type: 'title', id: chat.id, title: placeholderTitle });

    // Fire the AI title sub-request in the background. We `await` it before
    // emitting `done` so the client sees the upgraded title (if any) before
    // the turn closes — but the main stream is not blocked by it.
    const titleTask = backgroundTitleTask(res, {
      chatId: chat.id,
      model: chat.agent,
      userMessage: content,
    });

    await chatStatus.withLock(chat.id, async () => {
      messages.append(chat.id, 'user', content);
      const { content: reply, finishReason } = await runOpenClawStream(res, {
        chatId: chat.id,
        model: chat.agent,
        sessionKey: chat.openclaw_session_id,
        messages: [{ role: 'user', content }],
      });
      const stored = messages.append(chat.id, 'assistant', reply, finishReason);
      await titleTask;
      const finalTitle = chats.get(chat.id)?.title ?? placeholderTitle;
      writeSse(res, { type: 'done', id: chat.id, title: finalTitle, message: stored });
    });
    endSse(res);
  } catch (err) {
    streamError(res, err);
  }
});

chatsRouter.get('/status', (_req, res) => {
  res.json({
    working: chatStatus.workingIds(),
    activities: chatStatus.snapshot(),
  });
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
  res.json({ id, title });
});

chatsRouter.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  chats.rename(id, String(req.body?.title ?? ''), { manual: true });
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
        chatId: id,
        model: fresh.agent,
        sessionKey: fresh.openclaw_session_id,
        messages: historyForChat(id),
      });
      const stored: Message = messages.append(id, 'assistant', reply, finishReason);
      const finalTitle = chats.get(id)?.title ?? fresh.title;
      writeSse(res, { type: 'done', id, title: finalTitle, message: stored });
    });
    endSse(res);
  } catch (err) {
    streamError(res, err);
  }
});
