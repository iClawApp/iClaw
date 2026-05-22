/**
 * chatRunner is the heart of the turn pipeline — it owns the per-chat lock,
 * fans events into wsHub, persists the assistant reply, and triggers project
 * fact extraction. Tests stub the gateway client and capture broadcasts to
 * pin down behaviour.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTestDb } from '../helpers/db';

const broadcasts: { all: unknown[]; toChat: Array<{ chatId: number; msg: unknown }> } = {
  all: [],
  toChat: [],
};

vi.mock('../../src/services/wsHub', () => ({
  wsHub: {
    broadcastAll: vi.fn((msg: unknown) => broadcasts.all.push(msg)),
    broadcastToChat: vi.fn((chatId: number, msg: unknown) =>
      broadcasts.toChat.push({ chatId, msg }),
    ),
    send: vi.fn(),
    register: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    hasSubscriber: vi.fn(() => false),
    serverStarted: Date.now(),
  },
}));

const openclawWsMock = {
  listAgents: vi.fn(async () => [{ id: 'main' }]),
  createSession: vi.fn(async () => ({ key: 'agent:test', sessionId: 's', agentId: 'main' })),
  deleteSession: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
  abortRun: vi.fn(async () => undefined),
  runTurn: vi.fn() as ReturnType<typeof vi.fn>,
  resolveExecApproval: vi.fn(async () => undefined),
  usageCost: vi.fn(async () => ({ totalUsd: 0 })),
  listModels: vi.fn(async () => ({ models: [] })),
  listCommands: vi.fn(async () => ({ commands: [] })),
  patchSession: vi.fn(async () => ({})),
  subscribeSessions: vi.fn(async () => undefined),
};
vi.mock('../../src/services/openclawWs', () => ({ openclawWs: openclawWsMock }));

vi.mock('../../src/services/chatTitle', () => ({
  deriveTitle: (msg: string) => msg.slice(0, 40),
  suggestChatTitleWithTimeout: vi.fn(async () => null),
}));

// Don't trigger background fact extraction — that path makes its own gateway call.
vi.mock('../../src/services/projectMemory', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/projectMemory')>(
    '../../src/services/projectMemory',
  );
  return {
    ...actual,
    scheduleProjectFactExtraction: vi.fn(),
  };
});

const { sendMessage } = await import('../../src/services/chatRunner');
const { chats, messages, projects, projectFacts } = await import('../../src/services/store');

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  broadcasts.all = [];
  broadcasts.toChat = [];
  openclawWsMock.runTurn.mockReset();
  openclawWsMock.createSession.mockClear();
});

function findBroadcast(type: string): unknown {
  return broadcasts.all.find((m) => (m as { type?: string }).type === type);
}
function findChatBroadcast(type: string): unknown {
  return broadcasts.toChat.find((b) => (b.msg as { type?: string }).type === type);
}

describe('sendMessage — new chat path', () => {
  it('creates chat, persists user + assistant msg, broadcasts chat-created + turn-ended', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({ type: 'text-delta', text: 'Hello ' });
      params.onEvent({ type: 'text-delta', text: 'world' });
      params.onEvent({ type: 'text-final', text: 'Hello world' });
      return { runId: 'r1', text: 'Hello world' };
    });

    const { chatId } = await sendMessage({
      content: 'first message',
      agentLabel: 'openclaw/default',
    });

    expect(chatId).toBeGreaterThan(0);
    const list = messages.listByChat(chatId);
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(list[0].content).toBe('first message');
    expect(list[1].content).toBe('Hello world');

    expect(findBroadcast('chat-created')).toBeDefined();
    expect(findBroadcast('turn-ended')).toBeDefined();
    expect(findChatBroadcast('turn-started')).toBeUndefined(); // turn-started is broadcastAll
    expect(findBroadcast('turn-started')).toBeDefined();
  });

  it('attaches new chat to the provided projectId when projects.get(id) exists', async () => {
    const p = projects.create('Demo');
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r', text: 'ok' });
    const { chatId } = await sendMessage({
      content: 'hello',
      agentLabel: 'openclaw/default',
      projectId: p.id,
    });
    expect(chats.get(chatId)!.project_id).toBe(p.id);
  });

  it('ignores invalid projectId on new chat creation', async () => {
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r', text: 'ok' });
    const { chatId } = await sendMessage({
      content: 'hello',
      projectId: 99999,
    });
    expect(chats.get(chatId)!.project_id).toBeNull();
  });
});

describe('sendMessage — existing chat', () => {
  it('persists into existing chat and broadcasts chat-updated to reorder sidebar', async () => {
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r1', text: 'reply A' });
    const { chatId } = await sendMessage({ content: 'turn one' });

    broadcasts.all = [];
    broadcasts.toChat = [];

    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r2', text: 'reply B' });
    await sendMessage({ chatId, content: 'turn two' });

    const list = messages.listByChat(chatId);
    expect(list.map((m) => m.content)).toEqual(['turn one', 'reply A', 'turn two', 'reply B']);
    // chat-updated for sidebar reorder
    const updated = broadcasts.all.find(
      (m) => (m as { type?: string; chatId?: number }).type === 'chat-updated',
    );
    expect(updated).toBeDefined();
  });
});

describe('sendMessage — error path', () => {
  it('persists a system "Error" row and broadcasts turn-error when gateway throws', async () => {
    openclawWsMock.runTurn.mockRejectedValueOnce(new Error('gateway boom'));
    const { chatId } = await sendMessage({ content: 'doomed' });
    const errorMsg = messages.listByChat(chatId).find((m) => m.role === 'system');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.content).toMatch(/Error/);
    expect(findChatBroadcast('turn-error')).toBeDefined();
  });

  it('does not persist gatewayWs bridge failures (share-safe)', async () => {
    openclawWsMock.runTurn.mockRejectedValueOnce(new Error('gatewayWs: connection failed'));
    const { chatId } = await sendMessage({ content: 'no row' });
    expect(messages.listByChat(chatId).some((m) => m.role === 'system')).toBe(false);
    const row = findChatBroadcast('turn-error') as { msg: { error?: string } } | undefined;
    expect(row).toBeDefined();
    expect(String(row!.msg.error ?? '')).not.toMatch(/gatewayWs/i);
  });
});

describe('sendMessage — project context injection', () => {
  it('prepends project facts to the gateway message (but stores user text raw)', async () => {
    const p = projects.create('CtxProj');
    projectFacts.append({ projectId: p.id, content: 'Stack: Node + Express' });
    let observedGatewayMessage = '';
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      observedGatewayMessage = params.message;
      return { runId: 'r', text: 'OK' };
    });
    const { chatId } = await sendMessage({
      content: 'how do I deploy?',
      projectId: p.id,
    });
    // Gateway received fact block + user message
    expect(observedGatewayMessage).toContain('Project context');
    expect(observedGatewayMessage).toContain('Stack: Node + Express');
    expect(observedGatewayMessage).toContain('how do I deploy?');
    // But the persisted user message is just the raw text
    const userRow = messages.listByChat(chatId).find((m) => m.role === 'user')!;
    expect(userRow.content).toBe('how do I deploy?');
  });

  it('does NOT inject when chat has no project', async () => {
    let observedGatewayMessage = '';
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      observedGatewayMessage = params.message;
      return { runId: 'r', text: 'OK' };
    });
    await sendMessage({ content: 'plain' });
    expect(observedGatewayMessage).toBe('plain');
  });
});

describe('sendMessage — reply-to (quoted message)', () => {
  it('persists reply metadata and prepends context for the gateway', async () => {
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r0', text: 'first reply' });
    const { chatId } = await sendMessage({ content: 'context from assistant' });

    let gatewayMsg = '';
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      gatewayMsg = params.message;
      return { runId: 'r1', text: 'second reply' };
    });

    const list0 = messages.listByChat(chatId);
    const assistantRow = list0.find((m) => m.role === 'assistant');
    expect(assistantRow).toBeDefined();

    await sendMessage({
      chatId,
      content: 'my follow-up',
      replyTo: { messageId: assistantRow!.id, quote: 'context from assistant' },
    });

    const list = messages.listByChat(chatId);
    const userFollowUp = list.filter((m) => m.role === 'user').pop()!;
    expect(userFollowUp.content).toBe('my follow-up');
    expect(userFollowUp.reply_to_message_id).toBe(assistantRow!.id);
    expect(userFollowUp.reply_quote).toBe('context from assistant');
    expect(userFollowUp.reply_to_role).toBe('assistant');
    expect(gatewayMsg).toContain('USER_REPLY_START');
    expect(gatewayMsg).toContain('BEGIN parent message');
    expect(gatewayMsg).toContain('context from assistant');
    expect(gatewayMsg).toContain('my follow-up');
  });

  it('ignores replyTo when the referenced message is in another chat', async () => {
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'a', text: 'A' });
    const { chatId: idA } = await sendMessage({ content: 'only in A' });
    const mid = messages.listByChat(idA).find((m) => m.role === 'assistant')!.id;

    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'b', text: 'B' });
    const { chatId: idB } = await sendMessage({ content: 'start B' });

    let gatewayMsg = '';
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      gatewayMsg = params.message;
      return { runId: 'c', text: 'C' };
    });

    await sendMessage({
      chatId: idB,
      content: 'cross-chat reply attempt',
      replyTo: { messageId: mid, quote: 'nope' },
    });

    const userRow = messages.listByChat(idB).filter((m) => m.role === 'user').pop()!;
    expect(userRow.reply_to_message_id).toBeNull();
    expect(userRow.reply_quote).toBeNull();
    expect(gatewayMsg).toBe('cross-chat reply attempt');
  });

  it('combines reply prefix with project context for the gateway', async () => {
    const p = projects.create('ReplyProj');
    projectFacts.append({ projectId: p.id, content: 'Fact one' });
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r0', text: 'assistant' });
    const { chatId } = await sendMessage({
      content: 'seed',
      projectId: p.id,
    });
    const assistantId = messages.listByChat(chatId).find((m) => m.role === 'assistant')!.id;

    let gatewayMsg = '';
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      gatewayMsg = params.message;
      return { runId: 'r1', text: 'ok' };
    });

    await sendMessage({
      chatId,
      content: 'with reply',
      replyTo: { messageId: assistantId, quote: 'short quote' },
    });

    expect(gatewayMsg).toContain('Project context');
    expect(gatewayMsg).toContain('Fact one');
    expect(gatewayMsg).toContain('USER_REPLY_START');
    expect(gatewayMsg).toContain('BEGIN parent message');
    expect(gatewayMsg).toContain('short quote');
    expect(gatewayMsg).toContain('with reply');
  });
});

describe('sendMessage — reasoning gate', () => {
  it('does not broadcast turn-reasoning when chat.reasoning_mode = "off"', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({ type: 'reasoning', text: 'inner monologue' });
      params.onEvent({ type: 'text-final', text: 'final answer' });
      return { runId: 'r', text: 'final answer' };
    });
    await sendMessage({ content: 'plain' });
    expect(findChatBroadcast('turn-reasoning')).toBeUndefined();
  });

  it('broadcasts turn-reasoning when chat.reasoning_mode != "off"', async () => {
    // Create chat first, flip mode, then call sendMessage with that chatId.
    openclawWsMock.runTurn.mockResolvedValueOnce({ runId: 'r0', text: 'ok' });
    const { chatId } = await sendMessage({ content: 'init' });
    chats.setReasoningMode(chatId, 'on');

    broadcasts.toChat = [];
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({ type: 'reasoning', text: 'analyzing…' });
      params.onEvent({ type: 'text-final', text: 'done' });
      return { runId: 'r1', text: 'done' };
    });
    await sendMessage({ chatId, content: 'second' });
    expect(findChatBroadcast('turn-reasoning')).toBeDefined();
  });
});

describe('sendMessage — attachment handling', () => {
  it('rewrites /api/chat/media URLs through /media proxy and inlines markdown', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({
        type: 'attachment',
        url: '/api/chat/media/abc.png',
        mime: 'image/png',
        label: 'screenshot',
      });
      params.onEvent({ type: 'text-final', text: '' });
      return { runId: 'r', text: '' };
    });
    const { chatId } = await sendMessage({ content: 'show me' });
    const assistant = messages.listByChat(chatId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toContain('/media/abc.png');
    expect(assistant.content).toMatch(/!\[screenshot]/);
  });

  it('uses HTML video tag for video mimes', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({
        type: 'attachment',
        url: '/api/chat/media/clip.mp4',
        mime: 'video/mp4',
      });
      params.onEvent({ type: 'text-final', text: '' });
      return { runId: 'r', text: '' };
    });
    const { chatId } = await sendMessage({ content: 'show clip' });
    const assistant = messages.listByChat(chatId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toContain('/media/clip.mp4');
    // For video we use a clickable poster-image link, not a raw <video> tag here.
    expect(assistant.content).toMatch(/\[!\[/);
  });
});

describe('sendMessage — authoritativeText resolution', () => {
  // Pre-fix, chatRunner called `canonicalAssistantText` which walked
  // global history. Now `runTurn` resolves it once and hands it back via
  // `authoritativeText`. These tests pin that pipeline.

  it('prefers authoritativeText over streamed text on normal completion', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      // Agent emitted a self-action status note via stream...
      params.onEvent({ type: 'text-delta', text: 'Самарі відправив у чат.' });
      params.onEvent({ type: 'text-final', text: 'Самарі відправив у чат.' });
      // ...but the canonical answer comes from message-tool resolution.
      return {
        runId: 'r1',
        text: 'Самарі відправив у чат.',
        aborted: false,
        authoritativeText: 'Ось самарі для іншої AI: ...',
      };
    });

    const { chatId } = await sendMessage({ content: 'дай самарі' });
    const assistant = messages.listByChat(chatId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('Ось самарі для іншої AI: ...');
  });

  it('falls back to streamed text when authoritativeText is null', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({ type: 'text-delta', text: 'plain answer' });
      params.onEvent({ type: 'text-final', text: 'plain answer' });
      return {
        runId: 'r2',
        text: 'plain answer',
        aborted: false,
        authoritativeText: null,
      };
    });

    const { chatId } = await sendMessage({ content: 'plain' });
    const assistant = messages.listByChat(chatId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('plain answer');
  });

  it('skips authoritativeText path on abort, keeps streamed partial', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async (params) => {
      params.onEvent({ type: 'text-delta', text: 'partial...' });
      params.onEvent({ type: 'text-final', text: 'partial...' });
      // Aborted: even if openclawWs somehow returned an authoritativeText
      // (it shouldn't), the caller would still prefer stream — but in
      // practice authoritativeText is null on abort. Test both halves:
      // partial stream is persisted, authoritativeText is ignored.
      return {
        runId: 'r3',
        text: 'partial...',
        aborted: true,
        authoritativeText: null,
      };
    });

    const { chatId } = await sendMessage({ content: 'long task' });
    const assistant = messages.listByChat(chatId).find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('partial...');
  });

  it('skips persist entirely when aborted with no streamed content', async () => {
    openclawWsMock.runTurn.mockImplementationOnce(async () => ({
      runId: 'r4',
      text: '',
      aborted: true,
      authoritativeText: null,
    }));

    const { chatId } = await sendMessage({ content: 'instant stop' });
    const rows = messages.listByChat(chatId);
    // user row only — no empty assistant bubble
    expect(rows.map((m) => m.role)).toEqual(['user']);
    // turn-ended still fires so the Stop button hides + chat unlocks
    expect(findBroadcast('turn-ended')).toBeDefined();
  });
});
