/**
 * The thing that actually runs a turn against OpenClaw and persists the
 * results. Sits between the transport layer (WS handlers / route handlers)
 * and the OpenClaw WS client.
 *
 * Emits everything through wsHub so subscribed browser tabs see the turn live.
 */

import { randomUUID } from 'node:crypto';
import { chats, messages, projects } from './store';
import { buildGatewayUserMessage, scheduleProjectFactExtraction } from './projectMemory';
import { chatStatus } from './chatStatus';
import { openclawWs, type TurnEvent } from './openclawWs';
import { deriveTitle, suggestChatTitleWithTimeout } from './chatTitle';
import { toolActivityLabel } from './toolLabels';
import { wsHub } from './wsHub';

const DEFAULT_AGENT = 'openclaw/default';

/**
 * Map an iClaw agent label ("openclaw/default", "openclaw/code", ...) to the
 * raw OpenClaw agentId ("main", "code", ...).
 */
export function normalizeAgentId(label: string | null | undefined): string {
  if (!label || label === 'openclaw' || label === 'openclaw/default') return 'main';
  if (label.startsWith('openclaw/')) return label.slice('openclaw/'.length);
  return label;
}

/**
 * Ensure the chat has a real OpenClaw session key (agent:…). Creates one on
 * demand for new or legacy rows. Idempotent.
 */
async function ensureSession(chatId: number): Promise<string> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error(`chat ${chatId} not found`);
  const existing = chat.openclaw_session_id;
  if (typeof existing === 'string' && existing.startsWith('agent:')) return existing;
  const fresh = await openclawWs.createSession({ agentId: normalizeAgentId(chat.agent) });
  chats.replaceSessionKey(chatId, fresh.key);
  return fresh.key;
}

/**
 * Walk the canonical transcript backwards and return the most recent
 * assistant *text* row. OpenClaw mirrors `tools.message.send` outputs into
 * the transcript as a separate assistant entry, so this is the right place
 * to find the user-facing reply regardless of whether the agent used
 * freeform output or the message tool.
 *
 * Returns '' when no text row is found in the last `limit` rows.
 */
async function canonicalAssistantText(sessionKey: string, limit = 20): Promise<string> {
  const history = await openclawWs.getHistory(sessionKey, limit);
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== 'assistant') continue;
    const c = row.content;
    if (typeof c === 'string' && c.trim().length > 0) return c;
    if (Array.isArray(c)) {
      const parts = c.filter(
        (p): p is { type?: string; text?: string } => p !== null && typeof p === 'object',
      );
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('');
      if (text.trim().length > 0) return text;
    }
  }
  return '';
}

/** Rewrite OpenClaw's `/api/chat/media/*` URL into our `/media/*` proxy. */
function rewriteMediaUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/chat/media/')) return '/media' + url.slice('/api/chat/media'.length);
  return url;
}

/** Sidebar unread: set when a reply lands and no tab is subscribed to this chat. */
function syncSidebarUnread(chatId: number): void {
  if (wsHub.hasSubscriber(chatId)) {
    if (chats.markRead(chatId)) wsHub.broadcastAll({ type: 'chat-read', chatId });
  } else if (chats.markUnread(chatId)) {
    wsHub.broadcastAll({ type: 'chat-unread', chatId });
  }
}

/**
 * Run one turn end-to-end: ensure session exists, write user msg, stream
 * events to subscribers, persist assistant msg, optionally generate title.
 *
 * Caller is responsible for holding the chatStatus lock.
 */
async function runTurnLocked(opts: {
  chatId: number;
  content: string;
  isFirstTurn: boolean;
}): Promise<void> {
  const { chatId, content, isFirstTurn } = opts;
  const chat = chats.get(chatId)!;
  const sessionKey = await ensureSession(chatId);

  const gatewayMessage =
    chat.project_id != null && projects.get(chat.project_id)
      ? buildGatewayUserMessage(content, chat.project_id)
      : content;

  // Persist user message + broadcast (stored text is the literal user input —
  // project context is only prepended for the gateway).
  const userMsg = messages.append(chatId, 'user', content);
  wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: userMsg });

  // `messages.append` bumped `chats.updated_at`. Tell every tab so the sidebar
  // re-sorts and this chat jumps to the top live (instead of only after F5).
  const chatAfterUserMsg = chats.get(chatId);
  if (chatAfterUserMsg) {
    wsHub.broadcastAll({
      type: 'chat-updated',
      chatId,
      updatedAt: chatAfterUserMsg.updated_at,
    });
  }

  // Title sub-request, in background, on first turn only.
  const titleTask: Promise<void> = isFirstTurn
    ? suggestChatTitleWithTimeout({ model: chat.agent, userMessage: content })
        .then((suggested) => {
          if (!suggested) return;
          if (!chats.trySetAutoTitle(chatId, suggested)) return;
          // broadcastAll covers every subscriber + every sidebar — no need
          // to also broadcastToChat (those listeners are a subset of "all").
          const row = chats.get(chatId);
          if (row) {
            wsHub.broadcastAll({
              type: 'chat-updated',
              chatId,
              title: suggested,
              updatedAt: row.updated_at,
            });
          }
        })
        .catch(() => {})
    : Promise.resolve();

  // Tell subscribers the turn began.
  chatStatus.setActivity(chatId, { kind: 'thinking', label: 'Thinking…' });
  wsHub.broadcastAll({
    type: 'turn-started',
    chatId,
    runId: randomUUID(), // synthetic; real runId is internal to OpenClaw
    activity: { state: 'thinking', label: 'Thinking…' },
  });

  let switchedToGenerating = false;
  let assistantText = '';

  const onEvent = (ev: TurnEvent): void => {
    if (ev.type === 'text-delta') {
      if (!switchedToGenerating) {
        switchedToGenerating = true;
        chatStatus.setActivity(chatId, { kind: 'generating', label: 'Generating…' });
      }
      assistantText += ev.text;
      wsHub.broadcastToChat(chatId, { type: 'turn-delta', chatId, text: ev.text });
    } else if (ev.type === 'tool-start') {
      chatStatus.setActivity(chatId, {
        kind: 'tool',
        name: ev.name,
        label: ev.label,
        detail: ev.detail,
      });
      wsHub.broadcastToChat(chatId, {
        type: 'turn-tool',
        chatId,
        phase: 'start',
        name: ev.name,
        label: ev.label,
        detail: ev.detail,
      });
    } else if (ev.type === 'tool-end') {
      wsHub.broadcastToChat(chatId, {
        type: 'turn-tool',
        chatId,
        phase: 'end',
        name: ev.name,
        label: toolActivityLabel(ev.name),
      });
    } else if (ev.type === 'lifecycle') {
      chatStatus.setActivity(chatId, {
        kind: 'lifecycle',
        phase: ev.phase,
        label: ev.label,
      });
      wsHub.broadcastToChat(chatId, {
        type: 'turn-lifecycle',
        chatId,
        phase: ev.phase,
        label: ev.label,
      });
    } else if (ev.type === 'reasoning') {
      // Surface model reasoning only when the user opted in for this chat.
      // We re-read chat row every event because the toggle can flip mid-turn.
      const cur = chats.get(chatId);
      if (cur && cur.reasoning_mode && cur.reasoning_mode !== 'off') {
        wsHub.broadcastToChat(chatId, { type: 'turn-reasoning', chatId, text: ev.text });
      }
    } else if (ev.type === 'attachment') {
      const proxied = rewriteMediaUrl(ev.url);
      // Inline into the running text so the stream-renderer picks it up, AND
      // emit a dedicated attachment event for any client that wants to track
      // them separately (e.g. a future "files" pane).
      const md = ev.mime.startsWith('video/')
        ? `\n\n[![attachment](${proxied})](${proxied})\n`
        : `\n\n![${ev.label ?? 'attachment'}](${proxied})\n`;
      assistantText += md;
      wsHub.broadcastToChat(chatId, { type: 'turn-delta', chatId, text: md });
      wsHub.broadcastToChat(chatId, {
        type: 'turn-attachment',
        chatId,
        url: proxied,
        mime: ev.mime,
        label: ev.label,
      });
    }
  };

  const { text: gatewayAccumulated } = await openclawWs.runTurn({
    sessionKey,
    message: gatewayMessage,
    onEvent,
  });

  // Prefer chat.history's last assistant text — it's the gateway's
  // display-normalised view of the turn, which is the only place that
  // correctly resolves message-tool routing.
  //
  // When an agent picks `sourceReplyDeliveryMode: "message_tool_only"`, its
  // streamed freeform output (what `chat:final` carries) is an internal
  // status note like "Надіслав у чат короткий зведений висновок…", while the
  // real user-facing reply is appended to the transcript as a SEPARATE
  // projected assistant row by `tools.message.send`. canonicalAssistantText()
  // walks history backwards and returns that projected row.
  //
  // Since `runTurn` now waits for `chat:state=final` before resolving (see
  // openclawWs.ts), `chat.history` is guaranteed fresh by the time we fetch
  // it — no race. gatewayAccumulated stays as a fallback for cases where
  // history fetch fails, and our own streaming buffer is the last resort.
  const canonicalText = await canonicalAssistantText(sessionKey).catch(() => null);
  const finalText =
    canonicalText && canonicalText.trim().length > 0
      ? canonicalText
      : gatewayAccumulated.trim().length > 0
        ? gatewayAccumulated
        : assistantText;

  // Persist the assistant message + broadcast.
  const assistantMsg = messages.append(chatId, 'assistant', finalText, null);
  wsHub.broadcastToChat(chatId, {
    type: 'message-appended',
    chatId,
    message: assistantMsg,
  });
  syncSidebarUnread(chatId);

  const chatAfter = chats.get(chatId)!;
  if (chatAfter.project_id != null && projects.get(chatAfter.project_id)) {
    scheduleProjectFactExtraction({
      chatId,
      projectId: chatAfter.project_id,
      sharesToProject: Boolean(chatAfter.shares_to_project),
      userMessage: content,
      assistantText: finalText,
      assistantMessageId: assistantMsg.id,
    });
  }

  // Wait for the title task (if any) so the final `turn-ended` reflects it.
  await titleTask;

  // broadcastAll so every tab updates the sidebar dot (not only subscribers).
  wsHub.broadcastAll({
    type: 'turn-ended',
    chatId,
    title: chats.get(chatId)?.title ?? '',
  });
}

/**
 * Public entrypoint used by the WS message handler.
 *
 *  - If `chatId` is provided, send to that existing chat.
 *  - If not, create a new chat with `agentLabel` (or DEFAULT_AGENT) and run
 *    the first turn there.
 *
 * Streams everything through wsHub.
 */
import type { WebSocket } from 'ws';

export async function sendMessage(opts: {
  chatId?: number;
  content: string;
  agentLabel?: string;
  /** Project to attach this NEW chat to. Ignored when chatId is provided. */
  projectId?: number | null;
  requestId?: string;
  /**
   * Optional socket to subscribe to the chat the moment it's resolved/created.
   * Without this the originating socket would miss events emitted before the
   * `await sendMessage(...)` returns (the entire streaming turn).
   */
  subscriber?: WebSocket;
}): Promise<{ chatId: number }> {
  let chatId = opts.chatId;
  let isFirstTurn = false;

  if (chatId == null) {
    const agent = (opts.agentLabel ?? '').trim() || DEFAULT_AGENT;
    let projectId: number | null = null;
    if (
      typeof opts.projectId === 'number' &&
      Number.isFinite(opts.projectId) &&
      opts.projectId > 0 &&
      projects.get(opts.projectId)
    ) {
      projectId = opts.projectId;
    }
    const chat = chats.create(agent, projectId);
    chatId = chat.id;
    isFirstTurn = true;
    // Seed a placeholder title so the sidebar entry shows up immediately.
    chats.trySetAutoTitle(chatId, deriveTitle(opts.content));
    const created = chats.get(chatId)!;
    // Subscribe the originating socket BEFORE we emit chat-created or start
    // the turn — otherwise it would miss every event in this turn.
    if (opts.subscriber) wsHub.subscribe(opts.subscriber, chatId);
    const proj = created.project_id ? projects.get(created.project_id) : null;
    wsHub.broadcastAll({
      type: 'chat-created',
      chatId,
      title: created.title,
      agent: created.agent,
      projectId: created.project_id,
      projectName: proj?.name ?? null,
      updatedAt: created.updated_at,
    });
  } else {
    if (opts.subscriber) wsHub.subscribe(opts.subscriber, chatId);
    isFirstTurn =
      messages.listByChat(chatId).filter((m) => m.role === 'user').length === 0;
  }

  try {
    await chatStatus.withLock(chatId, () =>
      runTurnLocked({ chatId: chatId!, content: opts.content, isFirstTurn }),
    );
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    // Persist a system "error" row so F5 / cross-tab still see what happened
    // — without this an errored turn just shows a user msg with no reply.
    const errorMsg = messages.append(
      chatId,
      'system',
      `Error: ${errorText}`,
      null,
    );
    wsHub.broadcastToChat(chatId, {
      type: 'message-appended',
      chatId,
      message: errorMsg,
    });
    wsHub.broadcastToChat(chatId, {
      type: 'turn-error',
      chatId,
      requestId: opts.requestId,
      error: errorText,
    });
    // don't rethrow — we've already broadcast + persisted. Rethrowing only
    // leaks the error up to the WS handler which logs it again.
  }

  return { chatId };
}

export async function abortChatRun(chatId: number): Promise<void> {
  const chat = chats.get(chatId);
  if (!chat) return;
  if (chat.openclaw_session_id?.startsWith('agent:')) {
    await openclawWs.abortRun(chat.openclaw_session_id);
  }
}
