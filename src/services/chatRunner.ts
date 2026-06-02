/**
 * The thing that actually runs a turn against OpenClaw and persists the
 * results. Sits between the transport layer (WS handlers / route handlers)
 * and the OpenClaw WS client.
 *
 * Emits everything through wsHub so subscribed browser tabs see the turn live.
 */

import { randomUUID } from 'node:crypto';
import { chats, messages, projects, projectSecrets } from './store';
import { buildGatewayUserMessage, scheduleProjectFactExtraction } from './projectMemory';
import { chatStatus } from './chatStatus';
import { openclawWs, type TurnEvent } from './openclawWs';
import { deriveTitle, suggestChatTitleWithTimeout } from './chatTitle';
import { toolActivityLabel } from './toolLabels';
import { wsHub } from './wsHub';
import {
  gatewayAttachmentsFromPersisted,
  persistIncomingAttachments,
  type IncomingAttachment,
  type ProcessedAttachment,
} from './uploads';
import type { ChatMode, Message, MessageAttachment } from '../types';
import { DEFAULT_MODE, getModeDef } from './chatModes';
import { loadOpenRouterConfig } from './config';
import { createWorkSession, sendWorkMessage, subscribeWorkEvents } from './workRuntime';
import {
  streamComplete,
  openRouterEnabled,
  isOpenRouterFailure,
  type OpenRouterMessage,
} from './openRouter';
import {
  expandStoredSecretPlaceholdersForGateway,
  resolveInlineSecretMarkersInContent,
  stripSecretMarkersForTitle,
  type InlineSecretWire,
} from './inlineSecrets';

const DEFAULT_AGENT = 'openclaw/default';

/**
 * OpenClaw session key currently executing an Execute turn for a chat. Lets
 * `abortChatRun` stop the right gateway run. Cleared in the runTurn `finally`.
 */
const activeRunSessionKeys = new Map<number, string>();

/**
 * AbortController for an in-flight Ask (OpenRouter) turn, keyed by chatId. Ask
 * runs as a direct HTTP stream — not an OpenClaw run — so Stop aborts the fetch
 * here rather than via `openclawWs.abortRun`. Cleared in the Ask `finally`.
 */
const activeAskAborts = new Map<number, AbortController>();

/** Recent prior-thread messages replayed to the (stateless) Ask call. */
const ASK_CONTEXT_MAX_MESSAGES = 24;
const ASK_CONTEXT_PER_MSG_CHARS = 800;
const ASK_CONTEXT_TOTAL_CHARS = 12_000;

const ASK_SYSTEM_PROMPT = [
  "You're answering in iClaw's lightweight Ask mode — explanation, planning, or a",
  'direct answer to a question. You have no tools and cannot run code, edit files,',
  "or browse: just answer clearly and concisely. Reply in the user's language.",
].join('\n');

/**
 * Build the OpenRouter message array for an Ask turn. The OpenRouter call is
 * stateless, so we replay a compact snapshot of the recent thread (read from
 * iClaw's own message store — includes BOTH prior Execute and Ask turns) as
 * proper role-tagged messages, then the current question last.
 */
function buildAskMessages(
  chatId: number,
  currentUserMsgId: number,
  currentMessage: string,
): OpenRouterMessage[] {
  const prior = messages
    .listByChat(chatId)
    .filter((m) => m.id < currentUserMsgId && (m.role === 'user' || m.role === 'assistant'))
    .slice(-ASK_CONTEXT_MAX_MESSAGES);

  const history: OpenRouterMessage[] = [];
  let total = 0;
  for (const m of prior) {
    let text = m.content.replace(/\s+$/, '');
    if (!text) continue;
    if (text.length > ASK_CONTEXT_PER_MSG_CHARS) {
      text = text.slice(0, ASK_CONTEXT_PER_MSG_CHARS) + '…';
    }
    if (total + text.length > ASK_CONTEXT_TOTAL_CHARS) break;
    history.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
    total += text.length;
  }

  return [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: currentMessage },
  ];
}

/** Max chars kept from each side of the Ask exchange in the Execute bridge note. */
const ASK_BRIDGE_QUESTION_CHARS = 600;
const ASK_BRIDGE_ANSWER_CHARS = 1500;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Compact note injected into the main (Execute) session after a hard-Ask turn
 * so Execute is aware of the out-of-band Ask exchange.
 */
function buildAskBridgeNote(question: string, answer: string): string {
  return [
    'The user had an out-of-band "Ask" exchange (lightweight, no tools) in this chat:',
    '',
    `Q: ${clip(question, ASK_BRIDGE_QUESTION_CHARS)}`,
    '',
    `A: ${clip(answer, ASK_BRIDGE_ANSWER_CHARS)}`,
  ].join('\n');
}

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
 * Failures inside the OpenClaw WS bridge — never persist or share; the live
 * tab still gets `turn-error` with a human message.
 */
export function isGatewayBridgeFailure(err: unknown): boolean {
  const t = (err instanceof Error ? err.message : String(err)).trim();
  if (!t) return false;
  if (/gatewayws:/i.test(t) || /^gatewayws\b/i.test(t)) return true;
  if (/no auth token/i.test(t)) return true;
  return false;
}

export function gatewayBridgeFailureUserMessage(): string {
  return (
    'Could not connect to the OpenClaw gateway. Check that the gateway is running ' +
    'and the token is configured, then try again.'
  );
}

/**
 * Ensure the chat has a real OpenClaw session key (agent:…). New chats are
 * created with a uuid placeholder; this swaps it for a real gateway key on
 * the first turn. Idempotent.
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
 * When OpenClaw is configured with `visibleReplies: "message_tool"`, the
 * agent's freeform output and the `tools.message.send` payload get merged
 * by the gateway into a single assistant row. The freeform half is the
 * agent's own narration about what it sent — looks like
 * "Sent X to chat…" — in Ukrainian ("Надіслав у чат…"), Russian ("Отправил…"), or English —
 * and clutters the user-visible reply.
 *
 * This heuristic strips that opening narration when:
 *   - the FIRST paragraph matches the self-action verb pattern, AND
 *   - there is substantive (≥ 50 chars) content after it.
 *
 * Conservative: if removing the preamble would leave less than 50 chars,
 * we keep the text unchanged. We won't accidentally swallow a short reply
 * whose first sentence happens to start with "Sent…".
 */
// JS regex `\b` is ASCII-only, so it doesn't fire for Cyrillic verbs. We use
// a lookahead onto a non-letter character (space / period) instead, with the
// `/u` flag so the Cyrillic part of the alternation matches reliably.
const SELF_ACTION_PREAMBLE_RE =
  /^(?:Надіслав(?:ши)?|Відправ(?:ив|лено)|I sent|I've sent|Sent|Send|Отправил|Послал|Posted)(?=[^\p{L}])[^\n]{0,200}\.\s*\n\s*\n/iu;
const MIN_KEEP_CHARS = 50;

export function stripAgentSelfActionPreamble(text: string): string {
  if (!text) return text;
  const m = text.match(SELF_ACTION_PREAMBLE_RE);
  if (!m) return text;
  const stripped = text.slice(m[0].length).trimStart();
  return stripped.length >= MIN_KEEP_CHARS ? stripped : text;
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

const REPLY_QUOTE_MAX = 240;

function normalizeReplyQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, REPLY_QUOTE_MAX);
}

/** Validate client-supplied reply pointer; only user/assistant rows in this chat. */
function parseReplyForChat(
  chatId: number,
  raw: unknown,
): { messageId: number; quote: string; ref: Message } | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const mid = Number(o.messageId);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const ref = messages.get(mid);
  if (!ref || ref.chat_id !== chatId) return null;
  if (ref.role !== 'user' && ref.role !== 'assistant') return null;
  const q = normalizeReplyQuote(String(o.quote ?? ''));
  if (!q) return null;
  return { messageId: mid, quote: q, ref };
}

/** Enough for the model to understand the parent message; capped for token budget. */
const GATEWAY_REPLY_BODY_MAX = 1200;

function excerptForGateway(content: string): string {
  const s = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length <= GATEWAY_REPLY_BODY_MAX) return s;
  return s.slice(0, GATEWAY_REPLY_BODY_MAX) + '…';
}

/**
 * Rich reply context for the LLM: full (truncated) parent message body, not
 * only the short UI quote — so the assistant can answer coherently when the
 * highlight is a single word like "Downloads".
 */
function formatReplyGatewayBlock(ref: Message, clientQuote: string): string {
  const roleLabel =
    ref.role === 'user' ? 'user' : ref.role === 'assistant' ? 'assistant' : String(ref.role);
  const body = excerptForGateway(ref.content);
  const clip = clientQuote.trim().replace(/\r\n/g, '\n');
  const bodyOneLine = body.replace(/\s+/g, ' ');
  const clipOne = clip.replace(/\s+/g, ' ');
  const quoteMatchesBody =
    clipOne.length === 0 ||
    bodyOneLine.includes(clipOne) ||
    body.trimStart().startsWith(clip);
  /** Always tell the model what substring the UI used as the reply anchor (even when it is part of the parent body). */
  const anchorLine =
    clipOne.length > 0
      ? `\nSelected UI reply excerpt (the exact substring the user chose in the thread as the reply anchor; interpret the user's new text in relation to this and the parent body above): «${clipOne}»`
      : '';
  const mismatchNote =
    clipOne.length > 0 && !quoteMatchesBody
      ? `\nNote: that excerpt does not appear verbatim in the parent body above (normalization or truncation) — still treat it as the user's intended anchor.`
      : '';
  return (
    `[CONTEXT — threaded reply. The user's NEW message starts at USER_REPLY_START below. ` +
      `Above that marker is the full earlier message they refer to (role=${roleLabel}, id=${ref.id}). ` +
      `If they ask what they replied to / whether you see their reply, mention both the parent message and the «Selected UI reply excerpt» line when relevant. ` +
      `Otherwise read for continuity and answer the new text directly.]\n\n` +
      `--- BEGIN parent message (role=${roleLabel}, id=${ref.id}) ---\n` +
      body +
      anchorLine +
      mismatchNote +
      `\n--- END parent message ---\n\n` +
      `USER_REPLY_START\n`
  );
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
  replyTo?: unknown;
  incomingAttachments?: IncomingAttachment[];
  /** Attachments already saved under data/uploads (queued-message flush). */
  prePersistedAttachments?: MessageAttachment[];
  inlineSecrets?: InlineSecretWire[];
  /** 'ask' | 'execute'. Defaults to 'execute' for full back-compat. */
  mode?: ChatMode;
}): Promise<void> {
  const {
    chatId,
    content,
    isFirstTurn,
    replyTo,
    incomingAttachments,
    prePersistedAttachments,
    inlineSecrets,
  } = opts;
  const mode: ChatMode = opts.mode ?? DEFAULT_MODE;
  const chat = chats.get(chatId)!;
  const sessionKey = await ensureSession(chatId);
  const projectId = chat.project_id ?? null;

  let storedUserContent = content;
  let newSecretIds: number[] = [];
  if (/\[\[iclaw:s\d+\]\]/.test(content)) {
    const resolved = resolveInlineSecretMarkersInContent({
      content,
      inlineSecrets,
      projectId,
      sourceChatId: chatId,
    });
    storedUserContent = resolved.storedContent;
    newSecretIds = resolved.newSecretIds;
  } else if (inlineSecrets && inlineSecrets.length > 0) {
    throw new Error('inlineSecrets was sent without [[iclaw:sN]] markers in the message text.');
  }

  // Decode + persist attachments BEFORE the user-msg row so the row carries
  // the file URLs in the same broadcast. Validation errors throw and bubble up
  // to sendMessage's catch which surfaces them as turn-error.
  let processed: ProcessedAttachment[];
  if (prePersistedAttachments && prePersistedAttachments.length > 0) {
    const gateway = gatewayAttachmentsFromPersisted(chatId, prePersistedAttachments);
    processed = prePersistedAttachments.map((persisted, i) => ({
      persisted,
      forGateway: gateway[i]!,
    }));
  } else {
    processed = persistIncomingAttachments(chatId, incomingAttachments);
  }
  const persistedAttachments = processed.map((p) => p.persisted);
  const gatewayAttachments = processed.map((p) => p.forGateway);

  const reply = parseReplyForChat(chatId, replyTo);
  const chatScope = { id: chatId, project_id: projectId };
  let gatewayBody = expandStoredSecretPlaceholdersForGateway(storedUserContent, chatScope);
  if (reply) {
    const expandedParent = expandStoredSecretPlaceholdersForGateway(
      reply.ref.content,
      chatScope,
    );
    const refExpanded: Message = { ...reply.ref, content: expandedParent };
    gatewayBody = formatReplyGatewayBlock(refExpanded, reply.quote) + gatewayBody;
  }

  const gatewayMessageBase =
    chat.project_id != null && projects.get(chat.project_id)
      ? buildGatewayUserMessage(gatewayBody, chat.project_id)
      : gatewayBody;
  // The turn is dispatched AFTER the user row is persisted (Ask needs
  // userMsg.id to seed prior-thread context). See the Ask/Execute branch below.

  // Persist user message + broadcast (stored text keeps placeholders only).
  const replyToRole =
    reply && (reply.ref.role === 'user' || reply.ref.role === 'assistant') ? reply.ref.role : null;
  const userMsg = messages.append(
    chatId,
    'user',
    storedUserContent,
    null,
    reply && replyToRole
      ? {
          replyToMessageId: reply.messageId,
          replyQuote: reply.quote,
          replyToRole,
        }
      : null,
    persistedAttachments.length > 0 ? persistedAttachments : null,
    mode,
  );
  for (const sid of newSecretIds) {
    projectSecrets.setSourceMessage(sid, userMsg.id);
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

  // Ask gate (fail-closed). Ask answers via OpenRouter with no tools wired. If
  // OpenRouter isn't configured we REFUSE rather than silently routing a
  // tool-capable OpenClaw agent turn. (The composer also hides Ask without a
  // key — this covers a stale client or a direct API call.)
  if (getModeDef(mode).lightweight && !openRouterEnabled()) {
    const note =
      'Ask mode needs OPENROUTER_API_KEY configured on iClaw. Set it (see .env.example / README → "Chat modes"), or switch to Execute. Not running this turn.';
    const sys = messages.append(chatId, 'system', note, 'ask-unavailable');
    wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
    wsHub.broadcastAll({
      type: 'turn-ended',
      chatId,
      title: chats.get(chatId)?.title ?? '',
      aborted: false,
    });
    return;
  }

  // Title sub-request, in background, on first turn only.
  const titleTask: Promise<void> = isFirstTurn
    ? suggestChatTitleWithTimeout({ model: chat.agent, userMessage: storedUserContent })
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

  // Work Mode — routes to iclaw-runtime, returns early.
  if (mode === 'work') {
    await runWorkModeTurn({ chatId, content: gatewayMessageBase, onEvent });
    wsHub.broadcastAll({ type: 'turn-ended', chatId, title: chats.get(chatId)?.title ?? '', aborted: false });
    return;
  }

  // Run the turn. Two backends:
  //   - Ask (lightweight): a direct, tool-less OpenRouter completion. No agent,
  //     no tools wired — the model can't touch files/shell/browser. Deltas
  //     stream through the same `onEvent` path Execute uses; Stop aborts the
  //     fetch via `activeAskAborts`. Attachments aren't forwarded in Ask v1
  //     (text Q&A only). The Ask→Execute bridge below carries the exchange into
  //     the chat's main OpenClaw session so a later Execute turn is aware of it.
  //   - Execute: the chat's own main-agent OpenClaw session, full tools.
  const isAsk = getModeDef(mode).lightweight;
  let gatewayAccumulated = '';
  let aborted = false;
  let authoritativeText: string | null = null;

  if (isAsk) {
    const controller = new AbortController();
    activeAskAborts.set(chatId, controller);
    try {
      gatewayAccumulated = await streamComplete({
        model: loadOpenRouterConfig().askModel,
        messages: buildAskMessages(chatId, userMsg.id, gatewayMessageBase),
        signal: controller.signal,
        onDelta: (text) => onEvent({ type: 'text-delta', text }),
      });
    } catch (err) {
      // A user Stop aborts the fetch — treat as a normal aborted turn. The
      // partial text already streamed via onEvent (into `assistantText`) is
      // kept by the text-priority logic below. Anything else propagates.
      if (controller.signal.aborted) aborted = true;
      else throw err;
    } finally {
      activeAskAborts.delete(chatId);
    }
  } else {
    activeRunSessionKeys.set(chatId, sessionKey);
    try {
      ({
        text: gatewayAccumulated,
        aborted,
        authoritativeText,
      } = await openclawWs.runTurn({
        sessionKey,
        message: gatewayMessageBase,
        onEvent,
        attachments: gatewayAttachments.length > 0 ? gatewayAttachments : undefined,
      }));
    } finally {
      activeRunSessionKeys.delete(chatId);
    }
  }

  // Picking the assistant text in priority order:
  //
  //   1. `authoritativeText` — resolved inside `runTurn` from `chat.history`
  //      sliced to AFTER the current turn's user row. With
  //      `sourceReplyDeliveryMode: "message_tool_only"` it pulls
  //      `sourceReply.text` from the `message` tool's toolResult (the real
  //      user-facing answer); otherwise it falls back to the most recent
  //      assistant row in the slice. `null` on abort, on fetch failure,
  //      or when the slice was empty.
  //   2. `gatewayAccumulated` — what we collected from `chat:state=delta`.
  //      Right answer for plain freeform turns; on message-tool turns this
  //      is the agent's self-action status note (e.g. "Sent to chat…")
  //      so it's a fallback, not the preferred source.
  //   3. `assistantText` — our own buffer, last-resort when the gateway
  //      stream gave us nothing (rare).
  //
  // On abort, `authoritativeText` is intentionally `null`: an aborted run
  // has no fresh assistant row in history, so persisting a history-derived
  // text would surface stale text from the previous turn.
  const rawFinalText =
    authoritativeText && authoritativeText.trim().length > 0
      ? authoritativeText
      : gatewayAccumulated.trim().length > 0
        ? gatewayAccumulated
        : assistantText;

  // Strip the "Sent to chat…" self-narration preamble
  // that OpenClaw emits when `agents.defaults.visibleReplies` is set to
  // "message_tool". Conservative — only fires when there's a real reply
  // after the preamble (see stripAgentSelfActionPreamble for details).
  const finalText = stripAgentSelfActionPreamble(rawFinalText);

  // Aborted with no streamed content → skip the assistant row (would be
  // a confusing empty bubble). The "Stopped" marker below still goes in.
  const skipAssistant = aborted && finalText.trim().length === 0;
  const assistantMsg = skipAssistant
    ? null
    : messages.append(chatId, 'assistant', finalText, aborted ? 'aborted' : null);
  if (assistantMsg) {
    wsHub.broadcastToChat(chatId, {
      type: 'message-appended',
      chatId,
      message: assistantMsg,
    });
    syncSidebarUnread(chatId);
  }

  // Ask→Execute bridge. An Ask turn ran on OpenRouter, off to the side, so the
  // chat's main OpenClaw (Execute) session has no memory of it. Inject a compact
  // note into the main session (no model run, zero cost) so a later Execute
  // turn — "ok, now do what we discussed" — sees the exchange. Best-effort:
  // never let a bridge failure affect the turn the user already got. Stored
  // content keeps secret placeholders, so nothing sensitive is injected.
  if (isAsk && assistantMsg && !aborted && finalText.trim()) {
    const note = buildAskBridgeNote(storedUserContent, finalText);
    void openclawWs
      .injectMessage({ sessionKey, message: note, label: 'Ask' })
      .catch(() => {});
  }

  // Persistent "Stopped by user" marker. Lives in `messages` so it
  // survives page reload + lands in the iClaw-cloud share payload.
  // Rendered exactly like the existing "Task done: …" / "Task created:
  // …" notes — same centred soft-grey pill via `.msg.system`, no
  // special UI path. `finish_reason='aborted'` is kept for analytics /
  // future filtering, but the readable content is what the UI shows.
  if (aborted) {
    const marker = messages.append(chatId, 'system', 'Stopped by user', 'aborted');
    wsHub.broadcastToChat(chatId, {
      type: 'message-appended',
      chatId,
      message: marker,
    });
  }

  const chatAfter = chats.get(chatId)!;
  // Don't extract project facts from aborted turns — output is partial
  // and would feed noisy/half-formed claims into long-term memory.
  if (
    assistantMsg &&
    !aborted &&
    chatAfter.project_id != null &&
    projects.get(chatAfter.project_id)
  ) {
    scheduleProjectFactExtraction({
      chatId,
      projectId: chatAfter.project_id,
      sharesToProject: Boolean(chatAfter.shares_to_project),
      userMessage: storedUserContent,
      assistantText: finalText,
      assistantMessageId: assistantMsg.id,
    });
  }

  // Wait for the title task (if any) so the final `turn-ended` reflects it.
  await titleTask;

  // broadcastAll so every tab updates the sidebar dot (not only subscribers).
  // `aborted` lets the client clean up the streaming element it would
  // otherwise leave behind (status "Finishing…" never gets replaced when
  // skipPersist suppresses `message-appended`), and surface a minimal
  // "Stopped" indicator at the bottom of the thread.
  wsHub.broadcastAll({
    type: 'turn-ended',
    chatId,
    title: chats.get(chatId)?.title ?? '',
    aborted,
  });
}

function broadcastChatCreated(chatId: number): void {
  const created = chats.get(chatId);
  if (!created) return;
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
}

/** Draft composer row → visible sidebar entry on first user message. */
function promoteDraftChatIfNeeded(chatId: number, subscriber?: WebSocket): boolean {
  if (!chats.promoteFromDraft(chatId)) return false;
  if (subscriber) wsHub.subscribe(subscriber, chatId);
  broadcastChatCreated(chatId);
  return true;
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
  /** Optional reply-to snippet (validated server-side). */
  replyTo?: unknown;
  /** Optional inline secrets matching `[[iclaw:sN]]` in `content`. */
  inlineSecrets?: InlineSecretWire[];
  /**
   * Optional socket to subscribe to the chat the moment it's resolved/created.
   * Without this the originating socket would miss events emitted before the
   * `await sendMessage(...)` returns (the entire streaming turn).
   */
  subscriber?: WebSocket;
  /** Inline attachments from the browser. Decoded + persisted in runTurnLocked. */
  incomingAttachments?: IncomingAttachment[];
  /** Files already on disk (queued-message flush). */
  prePersistedAttachments?: MessageAttachment[];
  /** 'ask' | 'execute'. Defaults to 'execute' when omitted. */
  mode?: ChatMode;
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
    chats.trySetAutoTitle(chatId, deriveTitle(stripSecretMarkersForTitle(opts.content)));
    const created = chats.get(chatId)!;
    // Subscribe the originating socket BEFORE we emit chat-created or start
    // the turn — otherwise it would miss every event in this turn.
    if (opts.subscriber) wsHub.subscribe(opts.subscriber, chatId);
    broadcastChatCreated(chatId);
  } else {
    if (chats.isDraft(chatId)) {
      promoteDraftChatIfNeeded(chatId, opts.subscriber);
    } else if (opts.subscriber) {
      wsHub.subscribe(opts.subscriber, chatId);
    }
    isFirstTurn =
      messages.listByChat(chatId).filter((m) => m.role === 'user').length === 0;
  }

  try {
    await chatStatus.withLock(chatId, () =>
      runTurnLocked({
        chatId: chatId!,
        content: opts.content,
        isFirstTurn,
        replyTo: opts.replyTo,
        incomingAttachments: opts.incomingAttachments,
        prePersistedAttachments: opts.prePersistedAttachments,
        inlineSecrets: opts.inlineSecrets,
        mode: opts.mode,
      }),
    );
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    if (isGatewayBridgeFailure(err)) {
      wsHub.broadcastToChat(chatId, {
        type: 'turn-error',
        chatId,
        requestId: opts.requestId,
        error: gatewayBridgeFailureUserMessage(),
      });
    } else {
      // Persist a system "error" row so F5 / cross-tab still see what happened
      // — without this an errored turn just shows a user msg with no reply.
      const errorMsg = messages.append(chatId, 'system', `Error: ${errorText}`, null);
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
    }
    // don't rethrow — we've already broadcast + persisted. Rethrowing only
    // leaks the error up to the WS handler which logs it again.
  }

  return { chatId };
}

/** Persistent Work Mode sessions — one per chat, reused across turns. */
const workSessions = new Map<number, string>();

/**
 * Route a Work Mode turn to iclaw-runtime.
 * Reuses the session across turns to preserve conversation history.
 */
async function runWorkModeTurn(opts: {
  chatId: number;
  content: string;
  onEvent: (event: TurnEvent) => void;
}): Promise<void> {
  const { chatId, content, onEvent } = opts;

  // Reuse existing session for this chat, or create a new one
  let sessionId = workSessions.get(chatId);
  if (!sessionId) {
    try {
      // TODO: pass allowedFolders from project settings
      const allowedFolders = [process.env.HOME ?? ''].filter(Boolean);
      sessionId = await createWorkSession({ allowedFolders });
      workSessions.set(chatId, sessionId);
    } catch (err) {
      const note = `Work Mode runtime unavailable. (${err instanceof Error ? err.message : String(err)})`;
      const sys = messages.append(chatId, 'system', note, 'work-unavailable');
      wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
      return;
    }
  }

  try {
    await sendWorkMessage(sessionId, content);
  } catch (err) {
    // Session may have expired — retry with a fresh one
    workSessions.delete(chatId);
    const note = `Work Mode session lost, please resend. (${err instanceof Error ? err.message : String(err)})`;
    const sys = messages.append(chatId, 'system', note, null);
    wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
    return;
  }

  await new Promise<void>((resolve) => {
    let accumulated = '';
    const unsubscribe = subscribeWorkEvents(
      sessionId!,
      (event) => {
        if (event.type === 'text') {
          accumulated += event.content;
          onEvent({ type: 'text-delta', text: event.content });
        } else if (event.type === 'done') {
          if (accumulated.trim()) {
            const assistantMsg = messages.append(chatId, 'assistant', accumulated, null);
            wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: assistantMsg });
          }
          unsubscribe();
          resolve();
        } else if (event.type === 'error') {
          const sys = messages.append(chatId, 'system', `Work Mode error: ${event.message}`, null);
          wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
          unsubscribe();
          resolve();
        }
      },
      (err) => {
        // Ignore "aborted" — it just means the SSE stream closed normally
        if (err.message !== 'aborted') {
          const sys = messages.append(chatId, 'system', `Work Mode connection error: ${err.message}`, null);
          wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
        }
        resolve();
      },
    );
  });
}

export async function abortChatRun(chatId: number): Promise<void> {
  // Ask runs on OpenRouter via fetch — abort the controller, not a gateway run.
  const askAbort = activeAskAborts.get(chatId);
  if (askAbort) {
    askAbort.abort();
    return;
  }
  // Execute: abort the OpenClaw run on the session actually executing this turn.
  const active = activeRunSessionKeys.get(chatId);
  if (active && active.startsWith('agent:')) {
    await openclawWs.abortRun(active);
    return;
  }
  const chat = chats.get(chatId);
  if (!chat) return;
  if (chat.openclaw_session_id?.startsWith('agent:')) {
    await openclawWs.abortRun(chat.openclaw_session_id);
  }
}
