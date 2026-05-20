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
    expect(res.body.task.status).toBe('ready');

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

  it('runs each agent plan step before marking the task done', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Multi-step',
        goal: 'check project',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    await request(app)
      .post(`/tasks/${taskId}/approve-plan`)
      .set('Accept', 'application/json')
      .send({
        steps: [
          { actor: 'agent', title: 'Inspect repo' },
          { actor: 'agent', title: 'Summarize findings' },
        ],
      });

    let turn = 0;
    openclawWsMock.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent?: (e: { type: string; text?: string }) => void }) => {
        turn += 1;
        const text =
          turn === 1 ? 'First step ok.\nTASK_DONE' : 'Second step ok.\nTASK_DONE';
        onEvent?.({ type: 'text-final', text });
        return { runId: 'r' + turn, text };
      },
    );

    const runRes = await request(app)
      .post(`/tasks/${taskId}/run`)
      .set('Accept', 'application/json')
      .send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.task.status).toBe('done');
    expect(turn).toBe(2);

    const steps = taskSteps.listByTask(taskId);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('TASK_DONE after first agent step does not close task while plan has more steps', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Partial plan',
        goal: 'deploy services',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    await request(app)
      .post(`/tasks/${taskId}/approve-plan`)
      .set('Accept', 'application/json')
      .send({
        steps: [
          { actor: 'agent', title: 'List services' },
          { actor: 'human', title: 'Confirm targets' },
          { actor: 'agent', title: 'Deploy' },
        ],
      });

    openclawWsMock.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent?: (e: { type: string; text?: string }) => void }) => {
        const text = 'Listed.\nTASK_DONE';
        onEvent?.({ type: 'text-final', text });
        return { runId: 'r1', text };
      },
    );

    const runRes = await request(app)
      .post(`/tasks/${taskId}/run`)
      .set('Accept', 'application/json')
      .send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.task.status).toBe('needs_human');

    const steps = taskSteps.listByTask(taskId);
    expect(steps[0].status).toBe('done');
    expect(steps[1].status).toBe('needs_human');
    expect(steps[2].status).toBe('todo');
  });
});

describe('ADD_HUMAN_STEP during run', () => {
  it('inserts a new human plan step and pauses the task', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Dynamic human',
        goal: 'deploy',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    await request(app)
      .post(`/tasks/${taskId}/approve-plan`)
      .set('Accept', 'application/json')
      .send({
        steps: [
          { actor: 'human', title: 'Initial approval' },
          { actor: 'agent', title: 'Deploy service' },
          { actor: 'agent', title: 'Smoke test' },
        ],
      });

    const runRes = await request(app)
      .post(`/tasks/${taskId}/run`)
      .set('Accept', 'application/json')
      .send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.task.status).toBe('needs_human');

    openclawWsMock.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent?: (e: { type: string; text?: string }) => void }) => {
        const text =
          'Credentials invalid after deploy.\nADD_HUMAN_STEP: Re-enter API credentials\nNEEDS_HUMAN';
        onEvent?.({ type: 'text-final', text });
        return { runId: 'r-dyn', text };
      },
    );

    const resumeRes = await request(app)
      .post(`/tasks/${taskId}/resume`)
      .set('Accept', 'application/json')
      .send({ humanInput: 'approved once' });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.task.status).toBe('needs_human');

    const steps = taskSteps.listByTask(taskId);
    expect(steps).toHaveLength(4);
    expect(steps[0].status).toBe('done');
    expect(steps[1].title).toBe('Deploy service');
    expect(steps[1].status).toBe('todo');
    expect(steps[2].actor).toBe('human');
    expect(steps[2].title).toBe('Re-enter API credentials');
    expect(steps[2].status).toBe('needs_human');
    expect(steps[3].title).toBe('Smoke test');
    expect(steps[3].status).toBe('todo');
  });
});

describe('DELETE /tasks/:id', () => {
  it('removes the task and returns projectId for redirect', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'To delete',
        goal: 'g',
        generatePlan: false,
      });
    const taskId = createRes.body.task.id;

    const delRes = await request(app)
      .delete(`/tasks/${taskId}`)
      .set('Accept', 'application/json');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
    expect(tasks.get(taskId)).toBeUndefined();
  });
});

describe('GET /tasks/signals', () => {
  it('reports which task statuses need attention', async () => {
    const chat = chats.create('openclaw/default', null);
    const createRes = await request(app)
      .post('/tasks')
      .set('Accept', 'application/json')
      .send({
        sourceChatId: chat.id,
        title: 'Signals',
        goal: 'g',
        generatePlan: false,
      });
    const baseId = createRes.body.task.id;
    const snapId = createRes.body.task.context_snapshot_id;

    tasks.create({
      projectId: null,
      sourceChatId: chat.id,
      title: 'Run',
      goal: 'g',
      agent: 'openclaw/default',
      contextSnapshotId: snapId,
      status: 'running',
    });
    tasks.create({
      projectId: null,
      sourceChatId: chat.id,
      title: 'Review',
      goal: 'g',
      agent: 'openclaw/default',
      contextSnapshotId: snapId,
      status: 'needs_review',
    });
    tasks.updateStatus(baseId, 'needs_human');

    const res = await request(app).get('/tasks/signals').set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.hasAny).toBe(true);
    expect(res.body.signals).toEqual({
      needsHuman: true,
      running: true,
      needsReview: true,
    });
  });
});
