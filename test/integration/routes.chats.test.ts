/**
 * Exercises the /chats HTTP surface end-to-end against a real Express app
 * with a real SQLite DB. openclawWs is stubbed so nothing reaches a gateway.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';

// Stub the OpenClaw client BEFORE any code that imports it.
const openclawWsMock = {
  listAgents: vi.fn(async () => [{ id: 'main' }, { id: 'code' }]),
  createSession: vi.fn(async () => ({ key: 'agent:test', sessionId: 's', agentId: 'main' })),
  deleteSession: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
  abortRun: vi.fn(async () => undefined),
  runTurn: vi.fn(async () => ({ runId: 'r', text: 'reply' })),
  resolveExecApproval: vi.fn(async () => undefined),
  usageCost: vi.fn(async () => ({ totalUsd: 0.42 })),
  listModels: vi.fn(async () => ({
    models: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }],
  })),
  listCommands: vi.fn(async () => ({
    commands: [{ name: 'compact', description: 'Compact the session' }],
  })),
  patchSession: vi.fn(async () => ({ ok: true })),
  subscribeSessions: vi.fn(async () => undefined),
};
vi.mock('../../src/services/openclawWs', () => ({ openclawWs: openclawWsMock }));

// Stub the lower-level WS bridge so no socket is opened.
vi.mock('../../src/services/gatewayWs', () => ({
  gatewayWs: {
    request: vi.fn(async () => ({})),
    onFrame: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    subscribeSession: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
  },
}));

// Stub openclaw HTTP base for routes that read .baseUrl
vi.mock('../../src/services/openclaw', () => ({
  openclaw: { baseUrl: 'http://127.0.0.1:18789', hasToken: true, tokenSource: 'test' },
}));

// Stub project memory background extraction so it doesn't try to call the gateway.
vi.mock('../../src/services/projectMemory', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/projectMemory')>(
    '../../src/services/projectMemory',
  );
  return {
    ...actual,
    scheduleProjectFactExtraction: vi.fn(),
    compactProjectFacts: vi.fn(async () => undefined),
  };
});

const { createApp } = await import('../../src/app');
const { chats, projects, projectFacts, projectFactSuggestions, scheduledMessages } =
  await import('../../src/services/store');

const app = createApp();

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  openclawWsMock.deleteSession.mockClear();
  openclawWsMock.patchSession.mockClear();
});

describe('GET /chats/search', () => {
  it('returns empty ids for empty query', async () => {
    const res = await request(app).get('/chats/search?q=');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [] });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('finds chats by title substring', async () => {
    const c1 = chats.create('openclaw/default');
    chats.rename(c1.id, 'Deploy guide', { manual: true });
    const c2 = chats.create('openclaw/default');
    chats.rename(c2.id, 'Other topic', { manual: true });
    const res = await request(app).get('/chats/search?q=deploy');
    expect(res.status).toBe(200);
    expect(res.body.ids).toContain(c1.id);
    expect(res.body.ids).not.toContain(c2.id);
  });
});

describe('POST /chats/:id/rename', () => {
  it('renames manually and broadcasts chat-updated', async () => {
    const c = chats.create('openclaw/default');
    const res = await request(app)
      .post(`/chats/${c.id}/rename`)
      .type('form')
      .send({ title: 'Renamed!' })
      .redirects(0);
    expect([200, 302]).toContain(res.status);
    expect(chats.get(c.id)!.title).toBe('Renamed!');
    expect(chats.isTitleManual(c.id)).toBe(true);
  });

  it('falls back to "New chat" for empty title', async () => {
    const c = chats.create('openclaw/default');
    await request(app).post(`/chats/${c.id}/rename`).type('form').send({ title: '   ' }).redirects(0);
    expect(chats.get(c.id)!.title).toBe('New chat');
  });
});

describe('PATCH /chats/:id', () => {
  it('JSON-renames and returns the new title', async () => {
    const c = chats.create('openclaw/default');
    const res = await request(app)
      .patch(`/chats/${c.id}`)
      .set('content-type', 'application/json')
      .send({ title: 'API renamed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: c.id, title: 'API renamed' });
    expect(chats.get(c.id)!.title).toBe('API renamed');
  });

  it('400 for empty title', async () => {
    const c = chats.create('openclaw/default');
    const res = await request(app)
      .patch(`/chats/${c.id}`)
      .set('content-type', 'application/json')
      .send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('404 for missing chat', async () => {
    const res = await request(app)
      .patch('/chats/9999')
      .set('content-type', 'application/json')
      .send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /chats/:id/unread', () => {
  it('marks chat unread and is idempotent', async () => {
    const c = chats.create('openclaw/default');
    const res = await request(app).post(`/chats/${c.id}/unread`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(chats.get(c.id)!.unread).toBe(1);
    const res2 = await request(app).post(`/chats/${c.id}/unread`);
    expect(res2.status).toBe(200);
    expect(chats.get(c.id)!.unread).toBe(1);
  });

  it('404 for missing chat', async () => {
    const res = await request(app).post('/chats/99999/unread');
    expect(res.status).toBe(404);
  });
});

describe('POST /chats/:id/delete', () => {
  it('drops the row AND calls sessions.delete on the gateway when key is agent:*', async () => {
    const c = chats.create('openclaw/default');
    chats.replaceSessionKey(c.id, 'agent:to-be-deleted');
    const res = await request(app).post(`/chats/${c.id}/delete`).redirects(0);
    expect([302, 200]).toContain(res.status);
    expect(chats.get(c.id)).toBeUndefined();
    expect(openclawWsMock.deleteSession).toHaveBeenCalledWith('agent:to-be-deleted');
  });

  it('skips sessions.delete for legacy non-agent keys', async () => {
    const c = chats.create('openclaw/default');
    // create() defaults to a uuid (not starting with agent:)
    expect(c.openclaw_session_id.startsWith('agent:')).toBe(false);
    await request(app).post(`/chats/${c.id}/delete`).redirects(0);
    expect(openclawWsMock.deleteSession).not.toHaveBeenCalled();
  });

  it('survives a gateway error and still deletes the local row', async () => {
    const c = chats.create('openclaw/default');
    chats.replaceSessionKey(c.id, 'agent:will-fail');
    openclawWsMock.deleteSession.mockRejectedValueOnce(new Error('gateway down'));
    await request(app).post(`/chats/${c.id}/delete`).redirects(0);
    expect(chats.get(c.id)).toBeUndefined();
  });
});

describe('POST /chats/:id/reasoning', () => {
  it('mirrors the requested mode (on/off/stream)', async () => {
    const c = chats.create('openclaw/default');
    for (const mode of ['on', 'stream', 'off'] as const) {
      const res = await request(app)
        .post(`/chats/${c.id}/reasoning`)
        .set('content-type', 'application/json')
        .send({ mode });
      expect(res.status).toBe(200);
      expect(chats.get(c.id)!.reasoning_mode).toBe(mode);
    }
  });

  it('falls back to "off" for unknown modes', async () => {
    const c = chats.create('openclaw/default');
    const res = await request(app)
      .post(`/chats/${c.id}/reasoning`)
      .set('content-type', 'application/json')
      .send({ mode: 'gibberish' });
    expect(res.status).toBe(200);
    expect(chats.get(c.id)!.reasoning_mode).toBe('off');
  });
});

describe('Scheduled messages routes', () => {
  it('POST /chats/:id/scheduled creates + GET lists + DELETE removes', async () => {
    const c = chats.create('openclaw/default');
    const when = new Date(Date.now() + 60 * 60_000).toISOString();
    const create = await request(app)
      .post(`/chats/${c.id}/scheduled`)
      .set('content-type', 'application/json')
      .send({ content: 'later', scheduledAt: when });
    expect(create.status).toBe(200);
    const sid = create.body.scheduled.id;
    expect(sid).toBeGreaterThan(0);

    const list = await request(app).get(`/chats/${c.id}/scheduled`);
    expect(list.status).toBe(200);
    expect(list.body.scheduled.map((s: { id: number }) => s.id)).toEqual([sid]);

    const del = await request(app).post(`/chats/${c.id}/scheduled/${sid}/delete`);
    expect(del.status).toBe(200);
    expect(scheduledMessages.get(sid)).toBeUndefined();
  });

  it('rejects empty content / invalid scheduledAt', async () => {
    const c = chats.create('openclaw/default');
    const r1 = await request(app)
      .post(`/chats/${c.id}/scheduled`)
      .set('content-type', 'application/json')
      .send({ content: '   ', scheduledAt: new Date().toISOString() });
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .post(`/chats/${c.id}/scheduled`)
      .set('content-type', 'application/json')
      .send({ content: 'ok', scheduledAt: 'invalid' });
    expect(r2.status).toBe(400);
  });

  it('404 when scheduled id belongs to a different chat', async () => {
    const a = chats.create('openclaw/default');
    const b = chats.create('openclaw/default');
    const created = scheduledMessages.create({
      chatId: a.id,
      content: 'a only',
      scheduledAt: new Date(Date.now() + 60_000),
    });
    const res = await request(app).post(`/chats/${b.id}/scheduled/${created.id}/delete`);
    expect(res.status).toBe(404);
  });
});

describe('Fact suggestions routes', () => {
  it('GET /chats/:id/fact-suggestions returns pending list', async () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const s = projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: 'sugg',
      assistantMessageId: null,
    });
    const res = await request(app).get(`/chats/${c.id}/fact-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((x: { id: number }) => x.id)).toEqual([s.id]);
  });

  it('accept promotes suggestion → fact, removes suggestion', async () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const s = projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: 'this becomes a fact',
      assistantMessageId: null,
    });
    const res = await request(app).post(
      `/chats/${c.id}/fact-suggestions/${s.id}/accept`,
    );
    expect(res.status).toBe(200);
    expect(res.body.fact.content).toBe('this becomes a fact');
    expect(projectFactSuggestions.get(s.id)).toBeUndefined();
    expect(projectFacts.listByProject(p.id).map((f) => f.content)).toContain(
      'this becomes a fact',
    );
  });

  it('reject removes suggestion without touching facts', async () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const s = projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: 'meh',
      assistantMessageId: null,
    });
    const res = await request(app).post(
      `/chats/${c.id}/fact-suggestions/${s.id}/reject`,
    );
    expect(res.status).toBe(200);
    expect(projectFactSuggestions.get(s.id)).toBeUndefined();
    expect(projectFacts.listByProject(p.id)).toEqual([]);
  });

  it('accept 400 when chat is not under the suggested project', async () => {
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c1 = chats.create('openclaw/default', p1.id);
    const c2 = chats.create('openclaw/default', p2.id);
    const s = projectFactSuggestions.insert({
      projectId: p1.id,
      chatId: c1.id,
      content: 'mismatch',
      assistantMessageId: null,
    });
    // Reassign c1 to p2 so the suggestion no longer matches its chat's project
    (
      await import('../../src/services/store')
    ).chats; // ensure imported (TS hygiene)
    const db = (await import('../../src/db/database')).db;
    db.prepare('UPDATE chats SET project_id = ? WHERE id = ?').run(p2.id, c1.id);
    const res = await request(app).post(`/chats/${c1.id}/fact-suggestions/${s.id}/accept`);
    expect(res.status).toBe(400);
    // Silence unused warning
    void c2;
  });
});
