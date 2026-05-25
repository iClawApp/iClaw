/**
 * OpenClaw native WS client.
 *
 * Replaces the OpenAI-compat HTTP path used by openclaw.ts. Talks the real
 * Gateway WS protocol — agents.list, sessions.create, chat.send, chat.history,
 * and consumes the live `chat` / `agent` event streams.
 *
 * One open WS for the whole process — multiplexed via `gatewayWs.request()`
 * for RPC and `gatewayWs.onFrame()` for events.
 */

import { randomUUID } from 'node:crypto';
import { gatewayWs, type RawGatewayFrame } from './gatewayWs';
import { toolActivityLabel, lifecycleActivityLabel } from './toolLabels';
import {
  extractAssistantText,
  resolveFromHistorySlice,
  sliceFromLastUser,
} from './turnReply';

// ---------- shapes ---------------------------------------------------------

export interface OpenClawAgent {
  id: string;
  workspace?: string;
  model?: { primary?: string };
  agentRuntime?: { id: string; source?: string };
}

export interface OpenClawSession {
  key: string;
  sessionId: string;
  agentId?: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system' | 'toolResult' | string;
  content: unknown; // can be string or array of content parts
  timestamp?: number;
  toolName?: string;
  isError?: boolean;
}

export type TurnEvent =
  | { type: 'text-delta'; text: string }
  | {
      type: 'tool-start';
      name: string;
      label: string;
      /** Human-readable detail from data.meta — e.g. the actual command summary. */
      detail?: string;
      itemId?: string;
    }
  | { type: 'tool-end'; name: string; itemId?: string }
  | { type: 'lifecycle'; phase: string; label: string }
  | { type: 'attachment'; url: string; mime: string; label?: string; itemId?: string }
  /** Model reasoning / analysis text — only emitted, chatRunner decides whether to surface. */
  | { type: 'reasoning'; text: string }
  | { type: 'text-final'; text: string };

// ---------- helpers --------------------------------------------------------

interface AgentEventPayload {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: Record<string, unknown>;
  seq?: number;
}

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  state?: string;
  deltaText?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
}

interface SessionMessagePayload {
  sessionKey?: string;
  message?: {
    role?: string;
    content?: unknown;
    text?: string;
  };
}

/** Pull a flat string out of OpenAI-style content parts, or pass through. */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type?: string; text?: string } => p !== null && typeof p === 'object')
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('');
}

function safeString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After `chat:state=final`, OpenClaw may still append the canonical assistant
 * row and emit `session.message` / a second `final` (webchat post-dispatch).
 * Wait briefly before settling the turn so we don't persist the lifecycle
 * stream buffer ("Sent to chat…") instead of the transcript text.
 */
const POST_FINAL_CANONICAL_GRACE_MS = 1000;

/**
 * Gateway `chat.history` rejects limits above 1000 (OpenClaw 2026.5.x).
 */
const HISTORY_FETCH_LIMIT = 1000;
const HISTORY_FETCH_RETRIES = 3;
const HISTORY_FETCH_RETRY_DELAY_MS = 150;

async function fetchAuthoritativeFromHistory(sessionKey: string): Promise<string | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < HISTORY_FETCH_RETRIES; attempt++) {
    try {
      const res = await gatewayWs.request<{ messages: HistoryMessage[] }>(
        'chat.history',
        { sessionKey, limit: HISTORY_FETCH_LIMIT },
      );
      const resolved = resolveFromHistorySlice(sliceFromLastUser(res.messages ?? []));
      return resolved.trim().length > 0 ? resolved : null;
    } catch (err) {
      lastErr = err;
      if (attempt < HISTORY_FETCH_RETRIES - 1) {
        await sleep(HISTORY_FETCH_RETRY_DELAY_MS);
      }
    }
  }
  console.warn(
    '[openclawWs] chat.history failed after',
    HISTORY_FETCH_RETRIES,
    'attempts:',
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  );
  return null;
}

function pickAuthoritativeReplyText(opts: {
  fromHistory: string | null;
  fromTranscript: string | null;
  fromLastFinal: string;
}): string | null {
  if (opts.fromHistory && opts.fromHistory.trim().length > 0) return opts.fromHistory;
  if (opts.fromTranscript && opts.fromTranscript.trim().length > 0) {
    return opts.fromTranscript;
  }
  if (opts.fromLastFinal.trim().length > 0) return opts.fromLastFinal;
  return null;
}

/**
 * Per-session abort callbacks. Each active `runTurn` registers a function
 * here that resolves its `turnDone` promise as "aborted". When the gateway
 * acks `chat.abort` with `aborted: true`, `abortRun` fires every callback
 * for that sessionKey.
 *
 * Why a callback (not a flag the event handler reads): the gateway sends
 * `lifecycle:end` as an *event* and the `chat.abort` RPC *response*
 * separately on the same socket. The event can arrive on this side
 * BEFORE the RPC response completes — if we relied on a flag set after
 * the RPC awaited, the event handler would miss it and runTurn would
 * hang. Driving the resolution straight from the RPC response makes the
 * ordering irrelevant.
 *
 * The Set-of-callbacks shape covers the (theoretical) case of multiple
 * concurrent `runTurn` on the same sessionKey — aborting fires all.
 */
const pendingAborts = new Map<string, Set<() => void>>();

/**
 * Sessions where `abortRun` was called but the gateway returned
 * `aborted: false` (typically because `chat.send` is still in flight and
 * the run doesn't yet exist on the gateway). `runTurn` checks this set
 * immediately after `chat.send` returns and, if its session is marked,
 * re-issues `chat.abort` so the just-started run can be torn down.
 *
 * Without this, a Stop click during the brief `chat.send` window was
 * silently lost — the abort RPC reached the gateway too early, callbacks
 * never fired, and the user had to wait out the 3s button-debounce and
 * click again.
 */
const pendingAbortIntents = new Set<string>();

/**
 * Hard ceiling on how long we wait for `chat:state=final` after the
 * gateway already fired `lifecycle:end`. The two events normally arrive
 * within milliseconds of each other; if `state:final` is genuinely lost
 * (network blip across reconnect, gateway-side bug, certain agent
 * configurations), we fall back on the buffered stream text rather than
 * hang for the full 60-min upper-bound timeout.
 */
const POST_END_FINAL_GRACE_MS = 15_000;

// ---------- public client -------------------------------------------------

export const openclawWs = {
  async listAgents(): Promise<OpenClawAgent[]> {
    const res = await gatewayWs.request<{ agents: OpenClawAgent[] }>('agents.list', {});
    return res.agents ?? [];
  },

  /** Create a new "dashboard" session for an agent. Empty params → default agent. */
  async createSession(opts: { agentId?: string } = {}): Promise<OpenClawSession> {
    const params: Record<string, unknown> = {};
    if (opts.agentId) params.agentId = opts.agentId;
    const res = await gatewayWs.request<{
      key: string;
      sessionId: string;
    }>('sessions.create', params);
    return { key: res.key, sessionId: res.sessionId, agentId: opts.agentId };
  },

  async deleteSession(key: string): Promise<void> {
    await gatewayWs.request('sessions.delete', { key });
  },

  /** Fetch the canonical, UI-normalized transcript. */
  async getHistory(sessionKey: string, limit = 200): Promise<HistoryMessage[]> {
    const res = await gatewayWs.request<{ messages: HistoryMessage[] }>('chat.history', {
      sessionKey,
      limit,
    });
    return res.messages ?? [];
  },

  /**
   * Resolve a pending exec approval (gateway broadcasts `exec.approval.requested`
   * when the agent needs human OK to run a shell command). `decision` is
   * "approved" | "denied". `reason` is optional and surfaced to the agent.
   */
  async resolveExecApproval(opts: {
    approvalId: string;
    decision: 'approved' | 'denied';
    reason?: string;
  }): Promise<void> {
    const params: Record<string, unknown> = {
      approvalId: opts.approvalId,
      decision: opts.decision,
    };
    if (opts.reason) params.reason = opts.reason;
    await gatewayWs.request('exec.approval.resolve', params);
  },

  /** Get usage cost summary for a date range. */
  async usageCost(opts: { from?: string; to?: string } = {}): Promise<unknown> {
    return gatewayWs.request('usage.cost', opts as Record<string, unknown>);
  },

  /** Slash-command catalog for an agent — feeds the `/` autocomplete. */
  async listCommands(opts: { agentId?: string } = {}): Promise<unknown> {
    return gatewayWs.request('commands.list', opts as Record<string, unknown>);
  },

  /**
   * Patch a session's per-turn defaults (reasoning, model, thinking, etc.).
   * Only the fields you pass are touched; the gateway leaves the rest alone.
   * No-op when the session key isn't a real `agent:...` one yet.
   */
  async patchSession(opts: {
    sessionKey: string;
    reasoningLevel?: string | null;
    model?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
  }): Promise<void> {
    if (!opts.sessionKey.startsWith('agent:')) return;
    const params: Record<string, unknown> = { key: opts.sessionKey };
    if (opts.reasoningLevel !== undefined) params.reasoningLevel = opts.reasoningLevel;
    if (opts.model !== undefined) params.model = opts.model;
    if (opts.thinkingLevel !== undefined) params.thinkingLevel = opts.thinkingLevel;
    if (opts.fastMode !== undefined) params.fastMode = opts.fastMode;
    await gatewayWs.request('sessions.patch', params);
  },

  /** Read the gateway's current full config (incl. `hash` needed for config.patch). */
  async getConfig(): Promise<{ hash: string; config: Record<string, unknown> }> {
    const res = await gatewayWs.request<{
      hash: string;
      config: Record<string, unknown>;
    }>('config.get', {});
    return res;
  },

  /**
   * Merge-patch the gateway-wide config. `patch` is a JS object that the
   * gateway merges over the current config tree. `baseHash` is required for
   * optimistic-concurrency — the gateway rejects with a clear error if config
   * was changed between get/patch.
   *
   * Note: the gateway may auto-restart to apply the change. Our `gatewayWs`
   * client reconnects automatically, so callers just see a normal completion.
   */
  async patchConfig(opts: {
    patch: Record<string, unknown>;
    baseHash: string;
    note?: string;
  }): Promise<unknown> {
    return gatewayWs.request('config.patch', {
      raw: JSON.stringify(opts.patch),
      baseHash: opts.baseHash,
      ...(opts.note ? { note: opts.note } : {}),
    });
  },


  /** Subscribe to the global session index — needed for `sessions.changed`. */
  async subscribeSessions(): Promise<void> {
    await gatewayWs.request('sessions.subscribe', {});
  },

  /**
   * Abort an in-flight turn (no-op if already finished).
   *
   * If a `runTurn` is currently active on this session, records an intent
   * in `pendingAbortIntents` BEFORE awaiting the RPC. That covers the
   * Stop-during-chat.send race: at that moment the gateway has no run yet
   * (so `chat.abort` returns `aborted: false`), but the registered
   * callback IS in place — `runTurn` consumes the intent the moment
   * `chat.send` returns with a runId and re-issues the abort.
   *
   * We intentionally do NOT record an intent when no callback is
   * registered. Otherwise a stale intent could outlive the abort and
   * silently kill the very next turn the user starts on this session.
   */
  async abortRun(sessionKey: string, runId?: string): Promise<void> {
    const hasActiveRunTurn = (pendingAborts.get(sessionKey)?.size ?? 0) > 0;
    if (hasActiveRunTurn) pendingAbortIntents.add(sessionKey);
    const params: Record<string, unknown> = { sessionKey };
    if (runId) params.runId = runId;
    try {
      const res = (await gatewayWs.request('chat.abort', params)) as {
        ok?: boolean;
        aborted?: boolean;
      } | null;
      // Gateway emits `lifecycle:end` (not `aborted`) after a successful abort
      // and never emits `chat:state=final`, so runTurn would otherwise hang.
      // Drive resolution directly from this RPC response — see comment on
      // `pendingAborts` for why event-based marking is racey.
      if (res?.aborted) {
        // Intent satisfied — clear before firing callbacks so the runTurn's
        // post-chat.send re-check doesn't double-abort.
        pendingAbortIntents.delete(sessionKey);
        const callbacks = pendingAborts.get(sessionKey);
        if (callbacks) {
          for (const cb of Array.from(callbacks)) {
            try { cb(); } catch { /* never let one bad callback break the others */ }
          }
        }
      }
      // If `aborted: false`, the intent (if any) stays for the active
      // runTurn to consume. Without an active runTurn there is no intent,
      // so nothing leaks.
    } catch (err) {
      // chat.abort can legitimately fail if the turn already ended.
      // Surface any other failure so it doesn't stay silent.
      console.warn('[openclawWs] chat.abort failed:', (err as Error).message);
    }
  },

  /**
   * Send a user message and stream the resulting events.
   *
   * Resolves on `chat:state=final` (normal completion) or when an abort
   * fired via `abortRun` triggers our `onAbort` callback. Non-'end'
   * terminal lifecycle phases (`error`, `failed`, …) reject the promise.
   * The returned `aborted` flag tells the caller whether resolution came
   * from a user-initiated abort (so it can skip canonical-history reads,
   * fact extraction, etc.).
   *
   * `onEvent` fires for every interesting event during the turn.
   */
  async runTurn(opts: {
    sessionKey: string;
    message: string;
    onEvent: (ev: TurnEvent) => void;
    /** Optional custom idempotency key — defaults to random uuid. */
    idempotencyKey?: string;
    /**
     * Optional inline attachments forwarded verbatim to OpenClaw `chat.send`.
     * Shape matches the dashboard's normalized payload — `content` is base64
     * with or without `data:<mime>;base64,` prefix.
     */
    attachments?: Array<{
      type: 'image' | 'file';
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  }): Promise<{
    runId: string;
    text: string;
    aborted: boolean;
    /**
     * Canonical user-facing reply. Priority: `chat.history` slice (incl.
     * message-tool `sourceReply`), then `session.message` transcript row,
     * then the last `chat:state=final` after a short post-final grace.
     * `null` on abort or when nothing usable was found.
     */
    authoritativeText: string | null;
  }> {
    let runId: string | null = null;
    let accumulatedText = '';
    let lastFinalText = '';
    let transcriptAssistantText: string | null = null;
    let finalEmitted = false;
    let wasAborted = false;
    let endWatchdog: NodeJS.Timeout | null = null;
    let canonicalSettleTimer: NodeJS.Timeout | null = null;

    let resolveTurn!: () => void;
    let rejectTurn!: (err: Error) => void;
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const clearCanonicalSettleTimer = (): void => {
      if (canonicalSettleTimer) {
        clearTimeout(canonicalSettleTimer);
        canonicalSettleTimer = null;
      }
    };

    const settleTurn = (): void => {
      if (wasAborted) return;
      clearCanonicalSettleTimer();
      const text = lastFinalText || accumulatedText;
      if (!finalEmitted) {
        finalEmitted = true;
        opts.onEvent({ type: 'text-final', text });
      }
      resolveTurn();
    };

    const scheduleCanonicalSettle = (): void => {
      if (wasAborted) return;
      clearCanonicalSettleTimer();
      canonicalSettleTimer = setTimeout(() => {
        canonicalSettleTimer = null;
        settleTurn();
      }, POST_FINAL_CANONICAL_GRACE_MS);
      canonicalSettleTimer.unref?.();
    };

    // Register an abort callback BEFORE we kick off chat.send so the
    // race window (gateway acks abort before we register) is impossible.
    const onAbort = (): void => {
      if (wasAborted) return;          // idempotent — abort can fire twice
      wasAborted = true;
      clearCanonicalSettleTimer();
      if (!finalEmitted) {
        finalEmitted = true;
        opts.onEvent({ type: 'text-final', text: accumulatedText });
      }
      resolveTurn();
    };
    let abortSet = pendingAborts.get(opts.sessionKey);
    if (!abortSet) {
      abortSet = new Set();
      pendingAborts.set(opts.sessionKey, abortSet);
    }
    abortSet.add(onAbort);

    // Buffer events that arrive before chat.send returns with the runId.
    // OpenClaw can emit lifecycle/item events for the new run before the
    // RPC response reaches us.
    const buffered: RawGatewayFrame[] = [];

    const handleAgent = (payload: AgentEventPayload): void => {
      if (payload.sessionKey !== opts.sessionKey) return;
      if (runId && payload.runId && payload.runId !== runId) return;
      const stream = payload.stream;
      const data = payload.data ?? {};

      if (stream === 'lifecycle') {
        const phase = safeString(data.phase) ?? 'unknown';
        opts.onEvent({ type: 'lifecycle', phase, label: lifecycleActivityLabel(phase) });
        // Non-'end' terminal phases (error/aborted/cancelled/failed/...)
        // arrive only on agent-level failures, never as part of a normal
        // run. Reject so the caller surfaces them. For `phase === 'end'`
        // we DO NOT resolve here directly — gateway also emits
        // `chat:state=final` for successful completion which is the
        // canonical terminator (resolves there). On a `chat.abort`, the
        // abort RPC's response handler in `abortRun` calls our `onAbort`
        // callback, which is race-proof against event/response ordering.
        //
        // BUT: occasionally `state:final` never arrives after `end` —
        // network blip across reconnect, certain agent configs, gateway
        // bug. Arm a short grace timer so we don't hang for the full 60-
        // minute upper-bound timeout. If `state:final` does arrive later,
        // its `resolveTurn()` is a no-op on an already-settled promise.
        const TERMINAL_FAILURES = new Set([
          'error', 'aborted', 'cancelled',
          'failed', 'terminated', 'stopped',
        ]);
        if (TERMINAL_FAILURES.has(phase)) {
          if (!finalEmitted) {
            finalEmitted = true;
            opts.onEvent({ type: 'text-final', text: accumulatedText });
          }
          rejectTurn(new Error(`agent run ${phase}`));
          return;
        }
        if (phase === 'end' && !endWatchdog) {
          endWatchdog = setTimeout(() => {
            if (finalEmitted) return;
            // state:final didn't arrive — settle with what we have.
            finalEmitted = true;
            opts.onEvent({ type: 'text-final', text: accumulatedText });
            console.warn(
              '[openclawWs] lifecycle:end without chat:state=final after',
              POST_END_FINAL_GRACE_MS,
              'ms — resolving with buffered stream text',
            );
            scheduleCanonicalSettle();
          }, POST_END_FINAL_GRACE_MS);
          endWatchdog.unref?.();
        }
        return;
      }

      if (stream === 'item') {
        const kind = safeString(data.kind);
        if (kind === 'analysis') {
          // Reasoning / chain-of-thought. We always emit; chatRunner gates
          // delivery to subscribers based on per-chat reasoning_mode.
          const phase = data.phase;
          if (phase === 'start' || phase === 'end' || phase === 'completed') return;
          const text =
            safeString(data.text) ??
            safeString(data.deltaText) ??
            safeString(data.content) ??
            '';
          if (text) opts.onEvent({ type: 'reasoning', text });
          return;
        }
        const name = safeString(data.name) ?? kind ?? 'tool';
        const phase = data.phase;
        const itemId = safeString(data.itemId);

        if (kind === 'file' || kind === 'image' || kind === 'media') {
          // attachment item — emit when "completed" with a usable URL
          if (phase === 'completed' || phase === 'end') {
            const url = safeString(data.url);
            const mime = safeString(data.mimeType) ?? safeString(data.mime) ?? '';
            if (url) {
              opts.onEvent({
                type: 'attachment',
                url,
                mime,
                label: safeString(data.label) ?? safeString(data.name),
                itemId,
              });
            }
          }
          return;
        }

        if (phase === 'start') {
          // OpenClaw puts a concise human description in data.meta — for bash
          // it's a summary like "print lines 1-220 from USER.md (agent)".
          const detail = safeString(data.meta);
          opts.onEvent({
            type: 'tool-start',
            name,
            label: toolActivityLabel(name),
            detail,
            itemId,
          });
        } else if (phase === 'end' || phase === 'completed' || phase === 'error') {
          opts.onEvent({ type: 'tool-end', name, itemId });
        }
        return;
      }

      if (stream === 'assistant') {
        // Token-by-token text deltas come through here OR via the `chat` event
        // (state:'delta'). We listen to the `chat` event since it's the
        // canonical UI view. Skip this stream to avoid duplicates.
        return;
      }
    };

    const handleChat = (payload: ChatEventPayload): void => {
      if (payload.sessionKey !== opts.sessionKey) return;
      if (runId && payload.runId && payload.runId !== runId) return;

      if (payload.state === 'delta' && typeof payload.deltaText === 'string') {
        accumulatedText += payload.deltaText;
        opts.onEvent({ type: 'text-delta', text: payload.deltaText });
        return;
      }

      if (payload.state === 'final') {
        const text = contentToString(payload.message?.content) || accumulatedText;
        accumulatedText = text;
        lastFinalText = text;
        // OpenClaw may emit an early final (stream buffer) and a later webchat
        // final with the transcript-built message. Debounce turn settlement.
        scheduleCanonicalSettle();
        return;
      }
    };

    const handleSessionMessage = (payload: SessionMessagePayload): void => {
      if (payload.sessionKey !== opts.sessionKey) return;
      if (runId === null) return;
      const role = typeof payload.message?.role === 'string'
        ? payload.message.role.toLowerCase()
        : '';
      if (role !== 'assistant') return;
      const text =
        extractAssistantText(payload.message?.content) ||
        (typeof payload.message?.text === 'string' ? payload.message.text : '');
      if (text.trim().length > 0) transcriptAssistantText = text;
      scheduleCanonicalSettle();
    };

    const dispatch = (frame: RawGatewayFrame): void => {
      if (frame.type !== 'event') return;
      const eventName = frame.event;
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      if (eventName === 'agent') {
        handleAgent(payload as AgentEventPayload);
      } else if (eventName === 'chat') {
        handleChat(payload as ChatEventPayload);
      } else if (eventName === 'session.message') {
        handleSessionMessage(payload as SessionMessagePayload);
      }
    };

    const off = gatewayWs.onFrame((frame) => {
      if (runId === null) {
        // hold events until we know our runId
        buffered.push(frame);
      } else {
        dispatch(frame);
      }
    });

    try {
      // Subscribe via the bookkeeping helper — `subscribedSessions` is
      // tracked here so that an in-flight turn surviving a socket
      // reconnect gets its subscription auto-restored by `onConnected`.
      // Bypassing this (raw `request('sessions.messages.subscribe', …)`)
      // would let a reconnect silently stop event delivery and hang the
      // turn on its 60-minute upper-bound timeout.
      await gatewayWs.subscribeSession(opts.sessionKey);

      const sendRes = await gatewayWs.request<{ runId: string; status?: string }>(
        'chat.send',
        {
          sessionKey: opts.sessionKey,
          message: opts.message,
          idempotencyKey: opts.idempotencyKey ?? `iclaw-${randomUUID()}`,
          ...(opts.attachments && opts.attachments.length > 0
            ? { attachments: opts.attachments }
            : {}),
        },
        { timeoutMs: 30_000 },
      );
      runId = sendRes.runId;

      // Drain buffered events with the known runId.
      for (const f of buffered) dispatch(f);
      buffered.length = 0;

      // Stop-during-chat.send race: if abort was clicked while `chat.send`
      // was in flight, the gateway returned `aborted: false` (no run to
      // abort yet) and left the intent for us. Now that the run exists,
      // re-issue the abort. The callback fires from that RPC response and
      // resolves turnDone — no special handling needed below.
      if (pendingAbortIntents.has(opts.sessionKey)) {
        pendingAbortIntents.delete(opts.sessionKey);
        // Fire-and-forget — onAbort path will settle turnDone when the
        // gateway acks the abort. We don't await because awaiting here
        // would deadlock against `await turnDone` if the abort raced.
        void openclawWs.abortRun(opts.sessionKey, runId);
      }

      // Wait for the turn to finish. Resolvers:
      //   - `chat:state=final` event → normal completion
      //   - `onAbort` callback (from abortRun) → user abort
      //   - non-'end' terminal lifecycle phase → rejection
      //
      // 60 min upper bound — OpenClaw itself defaults to 48h for agent runs,
      // and real tool-heavy turns can comfortably run for 20–30 minutes. The
      // old 5 min cap was killing legitimate long runs on our side while the
      // gateway happily kept executing them.
      const timeout = setTimeout(() => {
        rejectTurn(new Error('runTurn: timed out waiting for turn to finish'));
      }, 60 * 60_000);
      try {
        await turnDone;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      if (endWatchdog) clearTimeout(endWatchdog);
      clearCanonicalSettleTimer();
      off();
      // Unregister the abort callback so a later abort on this sessionKey
      // (e.g. a new turn that re-uses it) doesn't accidentally hit this
      // run's resolver.
      const cbs = pendingAborts.get(opts.sessionKey);
      if (cbs) {
        cbs.delete(onAbort);
        if (cbs.size === 0) pendingAborts.delete(opts.sessionKey);
      }
      // Defensive: clear any leftover intent (e.g. a Stop click that
      // landed between `state:final` resolving and us reaching here).
      // The intent already missed its chance for this run; leaving it
      // would unfairly kill the next turn.
      pendingAbortIntents.delete(opts.sessionKey);
    }

    // Canonical reply: transcript/history first, then last `chat:final`, then stream.
    let authoritativeText: string | null = null;
    if (!wasAborted) {
      const fromHistory = await fetchAuthoritativeFromHistory(opts.sessionKey);
      authoritativeText = pickAuthoritativeReplyText({
        fromHistory,
        fromTranscript: transcriptAssistantText,
        fromLastFinal: lastFinalText || accumulatedText,
      });
    }

    return {
      runId: runId!,
      text: lastFinalText || accumulatedText,
      aborted: wasAborted,
      authoritativeText,
    };
  },
};
