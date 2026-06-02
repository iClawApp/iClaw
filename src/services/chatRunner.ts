/**
 * The thing that actually runs a turn against OpenClaw and persists the
 * results. Sits between the transport layer (WS handlers / route handlers)
 * and the OpenClaw WS client.
 *
 * Emits everything through wsHub so subscribed browser tabs see the turn live.
 */

import { randomUUID } from 'node:crypto';
import { chats, messages, projects, projectSecrets, projectFacts } from './store';
import { buildGatewayUserMessage, scheduleProjectFactExtraction } from './projectMemory';
import { buildSkillsPromptBlock, scheduleProjectSkillReview } from './projectSkills';
import { projectSkills } from './store';
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
import { DEFAULT_MODE } from './chatModes';
import { buildCompactedHistory } from './contextCompaction';
import { createWorkSession, sendWorkMessage, subscribeWorkEvents, stopWorkSession } from './workRuntime';
import {
  expandStoredSecretPlaceholdersForGateway,
  resolveInlineSecretMarkersInContent,
  stripSecretMarkersForTitle,
  type InlineSecretWire,
} from './inlineSecrets';

const DEFAULT_AGENT = 'openclaw/default';

/**
 * A folder granted to a Work Mode chat, with its access level. `readonly: true`
 * means the agent may read/list/search but not write_file or run_command under
 * it; `readonly: false` grants read & write. New folders default to read-only.
 */
export interface WorkFolder {
  path: string;
  readonly: boolean;
}

/**
 * OpenClaw session key currently executing an Execute turn for a chat. Lets
 * `abortChatRun` stop the right gateway run. Cleared in the runTurn `finally`.
 */
const activeRunSessionKeys = new Map<number, string>();

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
  /** 'execute' | 'work' | 'secure' | 'incognito'. Defaults to 'execute'. */
  mode?: ChatMode;
  workFolders?: WorkFolder[];
  networkEnabled?: boolean;
  ttlDays?: number;
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
  // Whether this turn invoked any tool — used to throttle skill review to
  // "substantive" turns (procedural learning comes from tool use, not chit-chat).
  let usedTools = false;

  const onEvent = (ev: TurnEvent): void => {
    if (ev.type === 'text-delta') {
      if (!switchedToGenerating) {
        switchedToGenerating = true;
        chatStatus.setActivity(chatId, { kind: 'generating', label: 'Generating…' });
      }
      assistantText += ev.text;
      wsHub.broadcastToChat(chatId, { type: 'turn-delta', chatId, text: ev.text });
    } else if (ev.type === 'tool-start') {
      usedTools = true;
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

  // Work / Secure Mode — routes to iclaw-runtime, returns early.
  if (mode === 'work' || mode === 'secure') {
    await runWorkModeTurn({ chatId, content: gatewayMessageBase, onEvent, workFolders: opts.workFolders, secure: mode === 'secure', networkEnabled: opts.networkEnabled, ttlDays: opts.ttlDays, beforeMsgId: userMsg.id, reviewUserMessage: storedUserContent });
    wsHub.broadcastAll({ type: 'turn-ended', chatId, title: chats.get(chatId)?.title ?? '', aborted: false });
    return;
  }

  // Execute: the chat's own main-agent OpenClaw session, full tools.
  let gatewayAccumulated = '';
  let aborted = false;
  let authoritativeText: string | null = null;

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

    // Procedural memory: throttled skill review (heavier than fact extraction,
    // so only every Nth substantive turn). MVP untrusted heuristic: a tool-using
    // turn with network reach may have ingested external content (web/email/etc.),
    // so its distilled skills are flagged for extra scrutiny in the inbox.
    // (This site handles Ask/Execute; Work/Secure returns earlier — see above.)
    scheduleProjectSkillReview({
      chatId,
      projectId: chatAfter.project_id,
      sharesToProject: Boolean(chatAfter.shares_to_project),
      substantive: usedTools,
      userMessage: storedUserContent,
      assistantText: finalText,
      assistantMessageId: assistantMsg.id,
      untrusted: usedTools && Boolean(opts.networkEnabled),
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
  /** Allowed folders for Work Mode, each with a read-only / read&write flag. */
  workFolders?: WorkFolder[];
  /** Network toggle for Secure Mode. */
  networkEnabled?: boolean;
  /** TTL in days for Secure Mode workspace. */
  ttlDays?: number;
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
        workFolders: opts.workFolders,
        networkEnabled: opts.networkEnabled,
        ttlDays: opts.ttlDays,
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

/** Build system prompt for Work/Secure Mode including project context. */
function buildWorkSystemPrompt(chatId: number): string {
  const chat = chats.get(chatId);
  const lines: string[] = [];

  if (chat?.project_id) {
    const project = projects.get(chat.project_id);
    if (project?.name) lines.push(`Project: ${project.name}`);
    if (project?.description) lines.push(`Description: ${project.description}`);

    const facts = projectFacts.listByProject(chat.project_id, 20);
    if (facts.length > 0) {
      lines.push('\nProject context:');
      facts.forEach((f) => lines.push(`- ${f.content}`));
    }

    const skillsBlock = buildSkillsPromptBlock(chat.project_id);
    if (skillsBlock) {
      lines.push('\n' + skillsBlock);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Persistent Work Mode sessions — one per chat, reused across turns. We store
 * the folder signature alongside the sessionId so a mid-chat change to the
 * folder set or a folder's read-only/read&write flag forces the session to be
 * recreated with the new access (folderAccess is fixed at session creation).
 */
const workSessions = new Map<
  number,
  { sessionId: string; foldersKey: string; secure: boolean; skillsKey: string }
>();

/**
 * Stable signature of the folders granted to a chat. Order-independent so the
 * key only changes when a path or its readonly flag actually changes.
 */
function foldersSignature(folders?: WorkFolder[]): string {
  if (!folders?.length) return '';
  return JSON.stringify(
    folders
      .map((f) => ({ p: f.path, r: f.readonly }))
      .sort((a, b) => a.p.localeCompare(b.p)),
  );
}

/**
 * Stable signature of the active skills injected into a chat's session. Changes
 * when a skill is accepted/edited/deleted (id+version), so the work session is
 * recreated with the new skill set without a manual restart — same class of fix
 * as folder-access / Work<->Secure mode changes.
 */
function skillsSignature(chatId: number): string {
  const chat = chats.get(chatId);
  if (!chat?.project_id) return '';
  const idx = projectSkills.listForProject(chat.project_id);
  if (idx.length === 0) return '';
  return idx
    .map((s) => `${s.id}:${s.version}`)
    .sort()
    .join(',');
}

/**
 * Skill-review cadence for Work/Secure. Smaller than the Ask/Execute interval:
 * these turns are agentic and tool-heavy, so each one is more likely to contain
 * a reusable procedure worth distilling.
 */
const WORK_SKILL_REVIEW_INTERVAL = 4;

/** Get the runtime sessionId for a chat (if active). */
export function getWorkSessionId(chatId: number): string | undefined {
  return workSessions.get(chatId)?.sessionId;
}

/**
 * Route a Work Mode turn to iclaw-runtime.
 * Reuses the session across turns to preserve conversation history.
 */
async function runWorkModeTurn(opts: {
  chatId: number;
  content: string;
  onEvent: (event: TurnEvent) => void;
  workFolders?: WorkFolder[];
  secure?: boolean;
  networkEnabled?: boolean;
  ttlDays?: number;
  /** Current user message id — history before it seeds the session context. */
  beforeMsgId?: number;
  /** Original (stored) user text for skill review — without injected project prefix. */
  reviewUserMessage?: string;
}): Promise<void> {
  const { chatId, content, onEvent } = opts;

  // Mode and folder access are baked in at session creation. Tear the session
  // down (so it's recreated below) when either changed since it was created:
  //   - the mode switched Work↔Secure, or
  //   - (Work only) the folder set or a read-only/read&write flag changed.
  // Without this, switching mode or toggling a folder in the UI is silently
  // ignored — the chat keeps running on the stale session.
  const wantSecure = !!opts.secure;
  const foldersKey = wantSecure ? '' : foldersSignature(opts.workFolders);
  const skillsKey = skillsSignature(chatId);
  const existing = workSessions.get(chatId);
  if (
    existing &&
    (existing.secure !== wantSecure ||
      (!wantSecure && existing.foldersKey !== foldersKey) ||
      existing.skillsKey !== skillsKey)
  ) {
    await stopWorkSession(existing.sessionId).catch(() => {});
    workSessions.delete(chatId);
    const note =
      existing.secure !== wantSecure
        ? `Mode changed — restarted the session in ${wantSecure ? 'Secure' : 'Work'} mode.`
        : existing.skillsKey !== skillsKey &&
            existing.foldersKey === foldersKey
          ? 'Project skills changed — restarted the work session with the updated skills.'
          : 'Folder access changed — restarted the work session with the new permissions.';
    const sys = messages.append(chatId, 'system', note, null);
    wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
  }

  // Reuse existing session for this chat, or create a new one
  let sessionId = workSessions.get(chatId)?.sessionId;
  if (!sessionId) {
    try {
      // Per-folder access drives both the allowed-path list and read-only
      // enforcement. Secure Mode ignores it (the sandbox workspace is the only
      // mount); when no folders are chosen we fall back to HOME with write
      // access, preserving prior behavior.
      const hasFolders = !opts.secure && !!opts.workFolders?.length;
      const folderAccess = hasFolders ? opts.workFolders : undefined;
      const allowedFolders = hasFolders
        ? opts.workFolders!.map((f) => f.path)
        : [process.env.HOME ?? ''].filter(Boolean);
      // Seed the (possibly restored) session with compacted prior history from
      // our DB, so context survives runtime restarts (older turns summarized).
      const history = opts.beforeMsgId
        ? await buildCompactedHistory(chatId, opts.beforeMsgId)
        : undefined;
      sessionId = await createWorkSession({
        allowedFolders,
        folderAccess,
        secure: opts.secure,
        systemPrompt: buildWorkSystemPrompt(chatId),
        // Stable key → the chat reconnects to its persisted Secure workspace
        // (and its running TTL) after a runtime restart.
        key: `chat:${chatId}`,
        history,
      });
      workSessions.set(chatId, { sessionId, foldersKey, secure: wantSecure, skillsKey });
    } catch (err) {
      const note = `Work Mode runtime unavailable. (${err instanceof Error ? err.message : String(err)})`;
      const sys = messages.append(chatId, 'system', note, 'work-unavailable');
      wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: sys });
      return;
    }
  }

  try {
    await sendWorkMessage(sessionId, content, opts.networkEnabled, opts.ttlDays);
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
            // Stamp the assistant row with the actual turn mode (secure/work),
            // not the append() default of 'execute'. Keeps history + UI honest.
            const assistantMsg = messages.append(
              chatId, 'assistant', accumulated, null, null, null,
              opts.secure ? 'secure' : 'work',
            );
            wsHub.broadcastToChat(chatId, { type: 'message-appended', chatId, message: assistantMsg });

            // Procedural memory: review Work/Secure turns too. These are agentic
            // and tool-capable by nature, so every completed turn counts as
            // "substantive". Untrusted heuristic: a turn with network reach may
            // have ingested external content (web/email/etc.). Throttled with a
            // smaller interval than Ask/Execute. Fire-and-forget.
            const chatNow = chats.get(chatId);
            if (chatNow?.project_id != null && projects.get(chatNow.project_id)) {
              scheduleProjectSkillReview({
                chatId,
                projectId: chatNow.project_id,
                sharesToProject: Boolean(chatNow.shares_to_project),
                substantive: true,
                userMessage: opts.reviewUserMessage ?? content,
                assistantText: accumulated,
                assistantMessageId: assistantMsg.id,
                untrusted: Boolean(opts.networkEnabled),
                interval: WORK_SKILL_REVIEW_INTERVAL,
              });
            }
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

/**
 * Incognito turns — fully ephemeral. Keyed by a client-generated string (the
 * browser's in-RAM chat id), NOT a DB chat. Nothing is persisted: no message
 * rows, no chat row, no facts/skills review. Output streams to the caller, who
 * forwards it to the originating socket only. The runtime session enforces
 * read-only + read-anywhere + web_fetch (incognito:true).
 */
const incognitoSessions = new Map<string, { sessionId: string; foldersKey: string }>();

export type IncognitoEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'error'; message: string };

export async function runIncognitoTurn(opts: {
  key: string;
  content: string;
  workFolders?: WorkFolder[];
  onEvent: (event: IncognitoEvent) => void;
}): Promise<void> {
  const { key, content, onEvent } = opts;

  // Recreate the runtime session if the selected folders changed (the shell's
  // :ro mounts are baked in at creation), mirroring the Work path.
  const foldersKey = foldersSignature(opts.workFolders);
  const existing = incognitoSessions.get(key);
  if (existing && existing.foldersKey !== foldersKey) {
    await stopWorkSession(existing.sessionId).catch(() => {});
    incognitoSessions.delete(key);
  }

  let sessionId = incognitoSessions.get(key)?.sessionId;
  if (!sessionId) {
    try {
      const folderAccess = opts.workFolders?.length ? opts.workFolders : undefined;
      // No HOME fallback: incognito reads anywhere via the runtime, and with no
      // folders the read-only shell is simply unavailable (file/web tools work).
      const allowedFolders = folderAccess ? folderAccess.map((f) => f.path) : [];
      sessionId = await createWorkSession({
        allowedFolders,
        folderAccess,
        incognito: true,
        key: `incognito:${key}`,
      });
      incognitoSessions.set(key, { sessionId, foldersKey });
    } catch (err) {
      onEvent({ type: 'error', message: `Incognito runtime unavailable. (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
  }

  try {
    await sendWorkMessage(sessionId, content);
  } catch (err) {
    incognitoSessions.delete(key);
    onEvent({ type: 'error', message: `Incognito session lost, please resend. (${err instanceof Error ? err.message : String(err)})` });
    return;
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = subscribeWorkEvents(
      sessionId!,
      (event) => {
        if (event.type === 'text') {
          onEvent({ type: 'text-delta', text: event.content });
        } else if (event.type === 'tool') {
          onEvent({ type: 'tool', name: event.name });
        } else if (event.type === 'done') {
          unsubscribe();
          resolve();
        } else if (event.type === 'error') {
          onEvent({ type: 'error', message: event.message });
          unsubscribe();
          resolve();
        }
      },
      (err) => {
        if (err.message !== 'aborted') onEvent({ type: 'error', message: err.message });
        resolve();
      },
    );
  });
}

/** Stop and forget an incognito session (abort / tab close). */
export async function abortIncognito(key: string): Promise<void> {
  const e = incognitoSessions.get(key);
  if (!e) return;
  incognitoSessions.delete(key);
  await stopWorkSession(e.sessionId).catch(() => {});
}

export async function abortChatRun(chatId: number): Promise<void> {
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
