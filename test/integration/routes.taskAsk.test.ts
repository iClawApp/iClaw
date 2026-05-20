import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';

const openclawWsMock = {
  listAgents: vi.fn(async () => [{ id: 'main' }]),
  createSession: vi.fn(async () => ({ key: 'agent:ask-test', sessionId: 's', agentId: 'main' })),
  deleteSession: vi.fn(async () => undefined),
  runTurn: vi.fn(async ({ onEvent }: { onEvent?: (e: { type: string; text?: string }) => void }) => {
    onEvent?.({ type: 'text-final', text: 'Answer from ask.' });
    return { runId: 'r', text: 'Answer from ask.' };
  }),
};
vi.mock('../../src/services/openclawWs', () => ({ openclawWs: openclawWsMock }));

vi.mock('../../src/services/gatewayWs', () => ({
  gatewayWs: {
    request: vi.fn(async () => ({})),
    onFrame: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    subscribeSession: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/services/openclaw', () => ({
  openclaw: {
    baseUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenSource: 'test',
    health: vi.fn(async () => true),
  },
}));

const { createApp } = await import('../../src/app');
const { chats, messages, tasks, taskAskSessions, taskContextSnapshots } = await import(
  '../../src/services/store',
);

const app = createApp();

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
});

describe('task Ask panel', () => {
  it('open/close does not change task status or frozen snapshot id', async () => {
    const chat = chats.create('openclaw/default', null);
    messages.append(chat.id, 'user', 'hello', null);

    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Ask test',
        goal: 'test goal',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;
    const frozenSnapId = tasks.get(taskId)!.context_snapshot_id;

    const openRes = await request(app)
      .post(`/tasks/${taskId}/ask/open`)
      .set('Accept', 'application/json')
      .send({});
    expect(openRes.status).toBe(200);
    const sessionId = openRes.body.sessionId;
    expect(taskAskSessions.get(sessionId)).toBeTruthy();
    expect(taskAskSessions.get(sessionId)!.context_snapshot_id).not.toBe(frozenSnapId);

    const closeRes = await request(app)
      .post(`/tasks/${taskId}/ask/close`)
      .set('Accept', 'application/json')
      .send({ sessionId });
    expect(closeRes.status).toBe(200);
    expect(taskAskSessions.get(sessionId)).toBeUndefined();

    const task = tasks.get(taskId)!;
    expect(task.status).toBe('ready');
    expect(task.context_snapshot_id).toBe(frozenSnapId);
    expect(openclawWsMock.deleteSession).toHaveBeenCalled();
  });
});
