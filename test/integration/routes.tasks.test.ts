import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';

const openclawWsMock = {
  listAgents: vi.fn(async () => [{ id: 'main' }]),
  createSession: vi.fn(async () => ({ key: 'agent:test', sessionId: 's', agentId: 'main' })),
  deleteSession: vi.fn(async () => undefined),
  runTurn: vi.fn(async ({ onEvent }: { onEvent?: (e: { type: string; text?: string }) => void }) => {
    onEvent?.({ type: 'text-final', text: 'Done.\nTASK_DONE' });
    return { runId: 'r', text: 'Done.\nTASK_DONE' };
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

vi.mock('../../src/services/projectMemory', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/projectMemory')>(
    '../../src/services/projectMemory',
  );
  return { ...actual, scheduleProjectFactExtraction: vi.fn() };
});

const { createApp } = await import('../../src/app');
const { chats, messages, tasks, taskSteps } = await import('../../src/services/store');

const app = createApp();

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
});

describe('POST /tasks', () => {
  it('creates task with snapshot', async () => {
    const chat = chats.create('openclaw/default', null);
    messages.append(chat.id, 'user', 'build feature', null);

    const res = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Feature',
        goal: 'build feature',
        generatePlan: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('Feature');
    expect(res.body.task.status).toBe('inbox');

    const sys = messages.listByChat(chat.id).filter((m) => m.role === 'system');
    expect(sys.some((m) => m.content.includes('Task created'))).toBe(true);
  });
});

describe('approve and run', () => {
  it('approve plan then run completes task', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'T',
        goal: 'do work',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    await request(app)
      .post(`/tasks/${taskId}/approve-plan`)
      .set('Accept', 'application/json')
      .send({
        steps: [{ actor: 'agent', title: 'Execute' }],
      });

    const task = tasks.get(taskId)!;
    expect(task.status).toBe('ready');

    const runRes = await request(app)
      .post(`/tasks/${taskId}/run`)
      .set('Accept', 'application/json')
      .send({});
    expect(runRes.status).toBe(200);
    expect(['done', 'needs_review']).toContain(runRes.body.task.status);
    expect(taskSteps.listByTask(taskId).length).toBeGreaterThan(0);
  });

  it('run pauses at first human step without calling the agent', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Human gate',
        goal: 'deploy',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    await request(app)
      .post(`/tasks/${taskId}/approve-plan`)
      .set('Accept', 'application/json')
      .send({
        steps: [
          { actor: 'human', title: 'Share credentials' },
          { actor: 'agent', title: 'Deploy service' },
        ],
      });

    openclawWsMock.runTurn.mockClear();

    const runRes = await request(app)
      .post(`/tasks/${taskId}/run`)
      .set('Accept', 'application/json')
      .send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.task.status).toBe('needs_human');
    expect(openclawWsMock.runTurn).not.toHaveBeenCalled();

    const steps = taskSteps.listByTask(taskId);
    expect(steps[0].status).toBe('needs_human');
    expect(steps[1].status).toBe('todo');
  });
});
