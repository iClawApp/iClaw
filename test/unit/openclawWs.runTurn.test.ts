/**
 * Unit tests for `openclawWs.runTurn` that stub `gatewayWs` to exercise
 * the abort-intent race fix, the lifecycle:end watchdog, and the
 * authoritativeText history-slice resolution.
 *
 * We mock `gatewayWs` at the module boundary so we can:
 *   - drive `request()` outcomes deterministically (chat.send, chat.abort,
 *     chat.history, sessions.messages.subscribe)
 *   - inject synthetic frames via the `onFrame` listener registered by
 *     runTurn (simulating gateway events arriving)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGatewayFrame } from '../../src/services/gatewayWs';

type FrameListener = (frame: RawGatewayFrame) => void;
type RequestImpl = (
  method: string,
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

// Test harness state — reset before every test.
let frameListeners: Set<FrameListener>;
let requestImpl: RequestImpl;
let subscribeSessionImpl: (sessionKey: string) => Promise<void>;

vi.mock('../../src/services/gatewayWs', () => {
  return {
    gatewayWs: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        return requestImpl(method, params);
      }),
      onFrame: vi.fn((fn: FrameListener) => {
        frameListeners.add(fn);
        return () => frameListeners.delete(fn);
      }),
      subscribeSession: vi.fn(async (sessionKey: string) => {
        return subscribeSessionImpl(sessionKey);
      }),
    },
  };
});

const { openclawWs } = await import('../../src/services/openclawWs');

function emit(payload: { event: 'agent' | 'chat'; payload: unknown }): void {
  const frame: RawGatewayFrame = {
    type: 'event',
    event: payload.event,
    payload: payload.payload,
  } as RawGatewayFrame;
  for (const fn of frameListeners) fn(frame);
}

function emitChatFinal(sessionKey: string, runId: string, text: string): void {
  emit({
    event: 'chat',
    payload: {
      sessionKey,
      runId,
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  });
}

function emitLifecycle(sessionKey: string, runId: string, phase: string): void {
  emit({
    event: 'agent',
    payload: {
      sessionKey,
      runId,
      stream: 'lifecycle',
      data: { phase },
    },
  });
}

/** Matches `POST_FINAL_CANONICAL_GRACE_MS` in openclawWs.ts */
const CANONICAL_GRACE_MS = 1000;

beforeEach(() => {
  vi.useFakeTimers();
  frameListeners = new Set();
  requestImpl = async () => ({});
  subscribeSessionImpl = async () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
  frameListeners.clear();
});

async function settleCanonicalGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CANONICAL_GRACE_MS);
}

function emitSessionMessage(sessionKey: string, text: string): void {
  emit({
    event: 'session.message',
    payload: {
      sessionKey,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  });
}

describe('runTurn — authoritativeText from chat.history slice', () => {
  it('requests chat.history with limit within gateway cap (1000)', async () => {
    const SK = 'agent:test:limit';
    const RID = 'run-limit';
    let historyLimit: unknown;

    requestImpl = async (method, params) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') {
        historyLimit = params.limit;
        return { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'ok' }] };
      }
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, RID, 'ok');
    await settleCanonicalGrace();
    await turnP;
    expect(historyLimit).toBe(1000);
  });

  it('returns message-tool sourceReply when present in slice', async () => {
    const SK = 'agent:test:s1';
    const RID = 'run-1';
    const authoritative = 'authoritative answer body';

    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'self-action status' },
            {
              role: 'toolResult',
              toolName: 'message',
              content: [
                {
                  type: 'toolResult',
                  content: JSON.stringify({
                    sourceReply: { text: authoritative },
                  }),
                },
              ],
            },
          ],
        };
      }
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });

    // Wait a tick so chat.send + buffered-drain finishes, then emit final.
    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, RID, 'self-action status');
    await settleCanonicalGrace();

    const result = await turnP;
    expect(result.authoritativeText).toBe(authoritative);
    expect(result.aborted).toBe(false);
  });

  it('prefers later chat:final over early status-note final', async () => {
    const SK = 'agent:test:two-finals';
    const RID = 'run-two-finals';
    const canonical = 'Дивись простіше. У GeeLark три проксі.';

    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, RID, 'Написав у чат короткий статус.');
    await vi.advanceTimersByTimeAsync(100);
    emitChatFinal(SK, RID, canonical);
    await settleCanonicalGrace();

    const result = await turnP;
    expect(result.authoritativeText).toBe(canonical);
    expect(result.text).toBe(canonical);
  });

  it('uses session.message transcript when history is empty', async () => {
    const SK = 'agent:test:session-msg';
    const RID = 'run-session-msg';
    const canonical = 'Текст з session.message після append.';

    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, RID, 'статус у стрімі');
    emitSessionMessage(SK, canonical);
    await settleCanonicalGrace();

    const result = await turnP;
    expect(result.authoritativeText).toBe(canonical);
  });

  it('skips authoritativeText resolution on abort', async () => {
    const SK = 'agent:test:s2';
    const RID = 'run-2';

    const historyMock = vi.fn();
    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.abort') return { ok: true, aborted: true };
      if (method === 'chat.history') {
        historyMock();
        return { messages: [] };
      }
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'long task',
      onEvent: () => undefined,
    });

    // Let chat.send settle.
    await Promise.resolve();
    await Promise.resolve();

    // User clicks Stop.
    await openclawWs.abortRun(SK);

    const result = await turnP;
    expect(result.aborted).toBe(true);
    expect(result.authoritativeText).toBeNull();
    expect(historyMock).not.toHaveBeenCalled();
  });

  it('falls back to last chat:final when history fetch fails', async () => {
    const SK = 'agent:test:s3';
    const RID = 'run-3';
    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') throw new Error('history blew up');
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, RID, 'streamed answer');
    await settleCanonicalGrace();
    // Post-turn history fetch retries use HISTORY_FETCH_RETRY_DELAY_MS.
    await vi.runAllTimersAsync();

    const result = await turnP;
    expect(result.authoritativeText).toBe('streamed answer');
    expect(result.text).toBe('streamed answer');
  });
});

describe('runTurn — abort intent (stop-during-chat.send race)', () => {
  it('re-issues abort after chat.send returns when intent recorded during send', async () => {
    const SK = 'agent:test:race';
    const RID = 'run-race';
    const abortCalls: Array<{ runId: string | undefined }> = [];
    let sendResolve!: (v: { runId: string }) => void;
    const sendPromise = new Promise<{ runId: string }>((res) => {
      sendResolve = res;
    });

    requestImpl = async (method, params) => {
      if (method === 'chat.send') return sendPromise;
      if (method === 'chat.abort') {
        abortCalls.push({ runId: params.runId as string | undefined });
        // First abort lands before chat.send returned ⇒ gateway has no run.
        // Second abort lands with a runId ⇒ gateway aborts it.
        if (abortCalls.length === 1) return { ok: true, aborted: false };
        return { ok: true, aborted: true };
      }
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });

    // chat.send is in-flight; user clicks Stop now.
    await openclawWs.abortRun(SK);
    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].runId).toBeUndefined();

    // Now chat.send completes — runTurn should consume the intent and
    // re-issue abort (this time with the known runId).
    sendResolve({ runId: RID });

    const result = await turnP;
    expect(result.aborted).toBe(true);
    expect(abortCalls.length).toBe(2);
    expect(abortCalls[1].runId).toBe(RID);
  });

  it('does NOT record an intent when no runTurn is active (no future-turn poisoning)', async () => {
    const SK = 'agent:test:no-active';
    const abortCalls: number[] = [];
    requestImpl = async (method) => {
      if (method === 'chat.abort') {
        abortCalls.push(Date.now());
        return { ok: true, aborted: false };
      }
      if (method === 'chat.send') return { runId: 'r-fresh' };
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    // Abort fires with no active runTurn for this session.
    await openclawWs.abortRun(SK);
    expect(abortCalls.length).toBe(1);

    // A subsequent runTurn must NOT immediately abort itself from stale intent.
    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'fresh start',
      onEvent: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    emitChatFinal(SK, 'r-fresh', 'normal answer');
    await settleCanonicalGrace();

    const result = await turnP;
    expect(result.aborted).toBe(false);
    // Only the original orphan abort; runTurn didn't fire a second one.
    expect(abortCalls.length).toBe(1);
  });
});

describe('runTurn — lifecycle:end watchdog', () => {
  it('does not resolve on lifecycle:end alone if state:final arrives shortly after', async () => {
    const SK = 'agent:test:end-then-final';
    const RID = 'run-end';
    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    emitLifecycle(SK, RID, 'end');
    // state:final follows almost immediately on a healthy run.
    emitChatFinal(SK, RID, 'final body');
    await settleCanonicalGrace();

    const result = await turnP;
    expect(result.text).toBe('final body');
    expect(result.aborted).toBe(false);
  });

  it('rejects on non-end terminal phases', async () => {
    const SK = 'agent:test:fail';
    const RID = 'run-fail';
    requestImpl = async (method) => {
      if (method === 'chat.send') return { runId: RID };
      if (method === 'chat.history') return { messages: [] };
      return {};
    };

    const turnP = openclawWs.runTurn({
      sessionKey: SK,
      message: 'q',
      onEvent: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    emitLifecycle(SK, RID, 'failed');

    await expect(turnP).rejects.toThrow(/failed/);
  });
});
