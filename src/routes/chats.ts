import { Router, type Request, type Response } from 'express';
import { chats, messages } from '../services/store';
import { openclaw } from '../services/openclaw';
import { openclawWs, type TurnEvent } from '../services/openclawWs';
import { chatStatus } from '../services/chatStatus';
import { beginSse, endSse, writeSse } from '../services/sse';
import { toolActivityLabel } from '../services/toolLabels';
import { deriveTitle, suggestChatTitleWithTimeout } from '../services/chatTitle';
import type { Message } from '../types';

export const chatsRouter: Router = Router();

const DEFAULT_AGENT = 'openclaw/default';

function wantsStream(req: Request): boolean {
  return req.headers.accept?.includes('text/event-stream') ?? false;
}

/**
 * Map iClaw's "agent" string (kept in chat.agent for compat with the old
 * OpenAI-compat path) into the agentId OpenClaw expects on the WS protocol.
 *
 *   "openclaw"          → "main"
 *   "openclaw/default"  → "main"
 *   "openclaw/code"     → "code"
 *   "openclaw/main"     → "main"
 *   any other id        → returned as-is
 */
function normalizeAgentId(label: string): string {
  if (!label || label === 'openclaw' || label === 'openclaw/default') return 'main';
  if (label.startsWith('openclaw/')) return label.slice('openclaw/'.length);
  return label;
}

/**
 * Returns a valid OpenClaw session key for this chat, creating one on demand
 * if the row doesn't carry a real (agent:…) key. There's no special legacy
 * path — any non-OpenClaw value is treated as "no session yet" and replaced.
 */
async function ensureOpenClawSession(chatId: number): Promise<{
  key: string;
  agentId: string;
}> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error(`chat ${chatId} not found`);
  const agentId = normalizeAgentId(chat.agent);
  const existing = chat.openclaw_session_id;
  if (typeof existing === 'string' && existing.startsWith('agent:')) {
    return { key: existing, agentId };
  }
  const fresh = await openclawWs.createSession({ agentId });
  chats.replaceSessionKey(chatId, fresh.key);
  return { key: fresh.key, agentId };
}

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

/**
 * Run one turn via OpenClaw WS, forwarding TurnEvents to the client SSE
 * stream and mirroring activity state into chatStatus so a reloaded page
 * sees the same label.
 */
async function runTurnAndForward(
  res: Response,
  opts: { chatId: number; sessionKey: string; message: string },
): Promise<{ content: string }> {
  writeSse(res, { type: 'status', status: 'thinking' });
  chatStatus.setActivity(opts.chatId, { kind: 'thinking', label: 'Thinking…' });

  let switchedToGenerating = false;
  const handle = (ev: TurnEvent): void => {
    if (ev.type === 'text-delta') {
      if (!switchedToGenerating) {
        switchedToGenerating = true;
        chatStatus.setActivity(opts.chatId, {
          kind: 'generating',
          label: 'Generating…',
        });
      }
      writeSse(res, { type: 'delta', text: ev.text });
    } else if (ev.type === 'tool-start') {
      writeSse(res, {
        type: 'tool',
        phase: 'start',
        name: ev.name,
        label: ev.label,
      });
      chatStatus.setActivity(opts.chatId, {
        kind: 'tool',
        name: ev.name,
        label: ev.label,
      });
    } else if (ev.type === 'tool-end') {
      writeSse(res, {
        type: 'tool',
        phase: 'end',
        name: ev.name,
        label: toolActivityLabel(ev.name),
      });
    } else if (ev.type === 'lifecycle') {
      writeSse(res, { type: 'lifecycle', phase: ev.phase, label: ev.label });
      chatStatus.setActivity(opts.chatId, {
        kind: 'lifecycle',
        phase: ev.phase,
        label: ev.label,
      });
    } else if (ev.type === 'attachment') {
      // Forward as a delta-like event injecting markdown into the body.
      // For now we just append a markdown image link to the running text.
      // (Real handling — including a /media proxy — lands in Phase 4.)
      const proxied = rewriteMediaUrlForProxy(ev.url);
      const md = ev.mime.startsWith('video/')
        ? `\n\n[![attachment](${proxied})](${proxied})\n`
        : `\n\n![${ev.label ?? 'attachment'}](${proxied})\n`;
      writeSse(res, { type: 'delta', text: md });
    }
    // text-final is implicit — we already streamed all deltas
  };

  const { text } = await openclawWs.runTurn({
    sessionKey: opts.sessionKey,
    message: opts.message,
    onEvent: handle,
  });
  return { content: text };
}

/**
 * Rewrite `/api/chat/media/...` from OpenClaw into our local /media proxy so
 * the browser can fetch it without the gateway bearer token. Anything that
 * already looks absolute (http/https) passes through unchanged.
 */
function rewriteMediaUrlForProxy(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/chat/media/')) return '/media' + url.slice('/api/chat/media'.length);
  return url;
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
  const agentLabel = String(req.body?.agent ?? '').trim() || DEFAULT_AGENT;
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }

  const chat = chats.create(agentLabel);
  const placeholderTitle = deriveTitle(content);
  chats.trySetAutoTitle(chat.id, placeholderTitle);

  // Build a real OpenClaw session before doing anything else.
  let session: { key: string; agentId: string };
  try {
    session = await ensureOpenClawSession(chat.id);
  } catch (err) {
    next(err);
    return;
  }

  if (!wantsStream(req)) {
    try {
      const reply = await chatStatus.withLock(chat.id, async () => {
        messages.append(chat.id, 'user', content);
        // Buffer text for non-streaming clients.
        let acc = '';
        const { text } = await openclawWs.runTurn({
          sessionKey: session.key,
          message: content,
          onEvent: (ev) => {
            if (ev.type === 'text-delta') acc += ev.text;
            else if (ev.type === 'text-final') acc = ev.text || acc;
          },
        });
        return messages.append(chat.id, 'assistant', text || acc, null);
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
    writeSse(res, { type: 'title', id: chat.id, title: placeholderTitle });
    const titleTask = backgroundTitleTask(res, {
      chatId: chat.id,
      model: chat.agent,
      userMessage: content,
    });

    await chatStatus.withLock(chat.id, async () => {
      messages.append(chat.id, 'user', content);
      const { content: reply } = await runTurnAndForward(res, {
        chatId: chat.id,
        sessionKey: session.key,
        message: content,
      });
      const stored = messages.append(chat.id, 'assistant', reply, null);
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

  let session: { key: string; agentId: string };
  try {
    session = await ensureOpenClawSession(id);
  } catch (err) {
    next(err);
    return;
  }

  if (!wantsStream(req)) {
    try {
      const stored = await chatStatus.withLock(id, async () => {
        messages.append(id, 'user', content);
        let acc = '';
        const { text } = await openclawWs.runTurn({
          sessionKey: session.key,
          message: content,
          onEvent: (ev) => {
            if (ev.type === 'text-delta') acc += ev.text;
            else if (ev.type === 'text-final') acc = ev.text || acc;
          },
        });
        return messages.append(id, 'assistant', text || acc, null);
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
      messages.append(id, 'user', content);
      const { content: reply } = await runTurnAndForward(res, {
        chatId: id,
        sessionKey: session.key,
        message: content,
      });
      const stored: Message = messages.append(id, 'assistant', reply, null);
      const finalTitle = chats.get(id)?.title ?? chat.title;
      writeSse(res, { type: 'done', id, title: finalTitle, message: stored });
    });
    endSse(res);
  } catch (err) {
    streamError(res, err);
  }
});
