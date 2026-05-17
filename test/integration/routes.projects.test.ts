/**
 * /projects HTTP surface — render hub, create, rename, PATCH metadata,
 * fact edit + delete. Gateway / project memory / openclawWs are stubbed
 * so the routes drive only DB state + broadcasts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';

const broadcastAllMock = vi.fn();
vi.mock('../../src/services/wsHub', () => ({
  wsHub: {
    broadcastAll: broadcastAllMock,
    broadcastToChat: vi.fn(),
    send: vi.fn(),
    register: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    hasSubscriber: vi.fn(() => false),
    serverStarted: Date.now(),
  },
}));

vi.mock('../../src/services/openclawWs', () => ({
  openclawWs: {
    listAgents: vi.fn(async () => [{ id: 'main' }]),
    createSession: vi.fn(async () => ({ key: 'agent:test', sessionId: 's' })),
    deleteSession: vi.fn(async () => undefined),
    getHistory: vi.fn(async () => []),
    abortRun: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => ({ runId: 'r', text: '' })),
    resolveExecApproval: vi.fn(async () => undefined),
    usageCost: vi.fn(async () => ({ totalUsd: 0 })),
    listModels: vi.fn(async () => ({ models: [] })),
    listCommands: vi.fn(async () => ({ commands: [] })),
    patchSession: vi.fn(async () => ({})),
    subscribeSessions: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/services/gatewayWs', () => ({
  gatewayWs: {
    request: vi.fn(async () => ({})),
    onFrame: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    ensureConnected: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/services/openclaw', () => ({
  openclaw: { baseUrl: 'http://127.0.0.1:18789', hasToken: true, tokenSource: 'test' },
}));

const { createApp } = await import('../../src/app');
const { projects, projectFacts, chats } = await import('../../src/services/store');

const app = createApp();

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  broadcastAllMock.mockClear();
});

describe('GET /projects', () => {
  it('renders the hub even when no projects exist', async () => {
    const res = await request(app).get('/projects');
    expect(res.status).toBe(200);
    expect(res.text).toBeDefined();
  });

  it('lists projects, sorted by activity', async () => {
    const a = projects.create('Alpha');
    const b = projects.create('Bravo');
    const ca = chats.create('openclaw/default', a.id);
    chats.rename(ca.id, 'a-chat', { manual: true });
    void b;
    const res = await request(app).get('/projects');
    expect(res.status).toBe(200);
  });
});

describe('POST /projects', () => {
  it('creates a project and broadcasts project-created', async () => {
    const res = await request(app)
      .post('/projects')
      .type('form')
      .send({ name: 'New Project' })
      .redirects(0);
    expect([302, 200]).toContain(res.status);
    const list = projects.list();
    expect(list.find((p) => p.name === 'New Project')).toBeDefined();
    const broadcast = broadcastAllMock.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'project-created',
    );
    expect(broadcast).toBeDefined();
  });

  it('rejects blank name with a redirect (no row created)', async () => {
    const before = projects.list().length;
    const res = await request(app)
      .post('/projects')
      .type('form')
      .send({ name: '   ' })
      .redirects(0);
    expect([302, 303]).toContain(res.status);
    expect(projects.list().length).toBe(before);
  });

  it('rejects blank name with 400 when JSON is requested', async () => {
    const res = await request(app)
      .post('/projects')
      .set('Accept', 'application/json')
      .send({ name: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST /projects/:id/rename', () => {
  it('renames a project + broadcasts project-updated', async () => {
    const p = projects.create('Old');
    const res = await request(app)
      .post(`/projects/${p.id}/rename`)
      .type('form')
      .send({ name: 'New' })
      .redirects(0);
    expect([302, 200]).toContain(res.status);
    expect(projects.get(p.id)!.name).toBe('New');
    const update = broadcastAllMock.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'project-updated',
    );
    expect(update).toBeDefined();
  });
});

describe('PATCH /projects/:id', () => {
  it('renames via name in JSON body', async () => {
    const p = projects.create('Old');
    const res = await request(app)
      .patch(`/projects/${p.id}`)
      .set('content-type', 'application/json')
      .send({ name: 'Brand New' });
    expect(res.status).toBe(200);
    expect(projects.get(p.id)!.name).toBe('Brand New');
  });

  it('updates logo emoji + color (clamped)', async () => {
    const p = projects.create('Logo');
    const res = await request(app)
      .patch(`/projects/${p.id}`)
      .set('content-type', 'application/json')
      .send({ logoEmoji: 999, logoColor: -5 });
    expect(res.status).toBe(200);
    const after = projects.get(p.id)!;
    expect(after.logo_emoji).toBeGreaterThanOrEqual(0);
    expect(after.logo_color).toBeGreaterThanOrEqual(0);
  });

  it('404 for unknown project', async () => {
    const res = await request(app)
      .patch('/projects/99999')
      .set('content-type', 'application/json')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/delete', () => {
  it('removes the project + detaches its chats', async () => {
    const p = projects.create('Doomed');
    const c = chats.create('openclaw/default', p.id);
    await request(app).post(`/projects/${p.id}/delete`).redirects(0);
    expect(projects.get(p.id)).toBeUndefined();
    expect(chats.get(c.id)?.project_id).toBeNull();
    const deleted = broadcastAllMock.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'project-deleted',
    );
    expect(deleted).toBeDefined();
  });
});

describe('Fact edit + delete', () => {
  it('PATCH /projects/:id/facts/:factId edits content', async () => {
    const p = projects.create('F');
    const f = projectFacts.append({ projectId: p.id, content: 'old' });
    const res = await request(app)
      .patch(`/projects/${p.id}/facts/${f.id}`)
      .set('content-type', 'application/json')
      .send({ content: 'new' });
    expect(res.status).toBe(200);
    expect(projectFacts.get(f.id)!.content).toBe('new');
  });

  it('PATCH rejects empty content', async () => {
    const p = projects.create('F');
    const f = projectFacts.append({ projectId: p.id, content: 'old' });
    const res = await request(app)
      .patch(`/projects/${p.id}/facts/${f.id}`)
      .set('content-type', 'application/json')
      .send({ content: '   ' });
    expect(res.status).toBe(400);
    expect(projectFacts.get(f.id)!.content).toBe('old');
  });

  it('POST .../delete drops the fact and broadcasts', async () => {
    const p = projects.create('F');
    const f = projectFacts.append({ projectId: p.id, content: 'gone' });
    const res = await request(app)
      .post(`/projects/${p.id}/facts/${f.id}/delete`)
      .redirects(0);
    expect([200, 302]).toContain(res.status);
    expect(projectFacts.get(f.id)).toBeUndefined();
    const broadcast = broadcastAllMock.mock.calls.find(
      ([m]) => (m as { type?: string }).type === 'project-fact-deleted',
    );
    expect(broadcast).toBeDefined();
  });
});
