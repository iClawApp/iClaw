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

  /** Abort an in-flight turn (no-op if already finished). */
  async abortRun(sessionKey: string, runId?: string): Promise<void> {
    const params: Record<string, unknown> = { key: sessionKey };
    if (runId) params.runId = runId;
    await gatewayWs.request('chat.abort', params).catch(() => {
      // chat.abort can fail if the turn already ended — that's fine.
    });
  },

  /**
   * Send a user message and stream the resulting events.
   *
   * Returns when the turn finishes (chat:final OR agent lifecycle:end).
   * `onEvent` is called for every interesting event during the turn.
   */
  async runTurn(opts: {
    sessionKey: string;
    message: string;
    onEvent: (ev: TurnEvent) => void;
    /** Optional custom idempotency key — defaults to random uuid. */
    idempotencyKey?: string;
  }): Promise<{ runId: string; text: string }> {
    let runId: string | null = null;
    let accumulatedText = '';
    let finalEmitted = false;

    let resolveTurn!: () => void;
    let rejectTurn!: (err: Error) => void;
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

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
        // Terminal lifecycle phases — anything that isn't 'start' means the
        // turn is over. We used to handle only 'end'; if the agent erroreda
        // or was aborted we'd hang forever on turnDone, leaving the chat
        // stuck in `working` state until the 5-min safety timeout.
        const TERMINAL = new Set([
          'end', 'error', 'aborted', 'cancelled',
          'failed', 'terminated', 'stopped',
        ]);
        if (TERMINAL.has(phase)) {
          if (phase === 'end') {
            // Successful completion: the gateway's canonical assistant message and
            // turn resolution come from the `chat` event (`state:final`). Resolving
            // here used to race ahead of that event, so chatRunner persisted from
            // chat.history before the final merged assistant row existed.
            return;
          }
          if (!finalEmitted) {
            finalEmitted = true;
            opts.onEvent({ type: 'text-final', text: accumulatedText });
          }
          rejectTurn(new Error(`agent run ${phase}`));
          return;
        }
        return;
      }

      if (stream === 'item') {
        const kind = safeString(data.kind);
        if (kind === 'analysis') return; // reasoning — skipped in v1
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
        // Always emit — lifecycle:end no longer resolves the turn, so this is the
        // primary signal for consumers that need the gateway's final assistant text.
        opts.onEvent({ type: 'text-final', text });
        if (!finalEmitted) {
          finalEmitted = true;
        }
        resolveTurn();
        return;
      }
    };

    const dispatch = (frame: RawGatewayFrame): void => {
      if (frame.type !== 'event') return;
      const eventName = frame.event;
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      if (eventName === 'agent') {
        handleAgent(payload as AgentEventPayload);
      } else if (eventName === 'chat') {
        handleChat(payload as ChatEventPayload);
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
      // Make sure the session emits per-session events (sessions.messages.subscribe).
      // This call is idempotent server-side.
      await gatewayWs
        .request('sessions.messages.subscribe', { key: opts.sessionKey })
        .catch(() => {
          /* if subscribe fails, broadcast events still flow for operator.read */
        });

      const sendRes = await gatewayWs.request<{ runId: string; status?: string }>(
        'chat.send',
        {
          sessionKey: opts.sessionKey,
          message: opts.message,
          idempotencyKey: opts.idempotencyKey ?? `iclaw-${randomUUID()}`,
        },
        { timeoutMs: 30_000 },
      );
      runId = sendRes.runId;

      // Drain buffered events with the known runId.
      for (const f of buffered) dispatch(f);
      buffered.length = 0;

      // Wait for the turn to finish (`chat` state:final resolves the promise;
      // agent lifecycle:end alone does not — see handleAgent).
      // 5 min upper bound — agent runs can be slow with tool calls.
      const timeout = setTimeout(() => {
        rejectTurn(new Error('runTurn: timed out waiting for turn to finish'));
      }, 5 * 60_000);
      try {
        await turnDone;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      off();
    }

    return { runId: runId!, text: accumulatedText };
  },
};
