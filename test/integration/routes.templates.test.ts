/**
 * /templates — gallery render + template activation into draft chats.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';
import {
  installCatalogFetchMock,
  resetMockTemplatesStore,
} from '../helpers/catalogFetchMock';

vi.mock('../../src/services/wsHub', () => ({
  wsHub: {
    broadcastAll: vi.fn(),
    broadcastToChat: vi.fn(),
    send: vi.fn(),
    register: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    hasSubscriber: vi.fn(() => false),
    serverStarted: Date.now(),
  },
}));

const listAgentsMock = vi.fn(async () => [{ id: 'main' }, { id: 'code' }]);

vi.mock('../../src/services/openclawWs', () => ({
  openclawWs: {
    listAgents: listAgentsMock,
    createSession: vi.fn(async () => ({ key: 'agent:test', sessionId: 's' })),
    deleteSession: vi.fn(async () => undefined),
    getHistory: vi.fn(async () => []),
    abortRun: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => ({ runId: 'r', text: '' })),
    resolveExecApproval: vi.fn(async () => undefined),
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
  openclaw: {
    baseUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenSource: 'test',
    health: vi.fn(async () => true),
  },
  cloudShareBaseUrl: 'http://127.0.0.1:4000',
}));

const { createApp } = await import('../../src/app');
const { chats } = await import('../../src/services/store');
const { catalog, resetCatalogCacheForTests, resolveAgentLabel } = await import(
  '../../src/services/catalog'
);

const app = createApp();

beforeAll(() => {
  resetTestDb();
  process.env.ICLAW_CLOUD_URL = 'http://127.0.0.1:4000';
  installCatalogFetchMock();
  resetCatalogCacheForTests();
});

afterEach(() => {
  resetTestDb();
  resetMockTemplatesStore();
  resetCatalogCacheForTests();
  listAgentsMock.mockResolvedValue([{ id: 'main' }, { id: 'code' }]);
});

describe('GET /templates', () => {
  it('renders the gallery from iClaw-cloud API', async () => {
    const res = await request(app).get('/templates');
    expect(res.status).toBe(200);
    expect(res.text).toContain('AI SMM-спеціаліст');
    expect(res.text).toContain('Roles');
  });
});

describe('POST /templates/activate', () => {
  it('creates a draft chat with substituted preamble and template_id', async () => {
    const res = await request(app)
      .post('/templates/activate')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        templateId: 'smm-specialist',
        answers: { platform: 'Instagram', count: '5', tone: 'Дружній' },
      });

    expect(res.status).toBe(200);
    expect(res.body.chatId).toBeTypeOf('number');

    const chat = chats.get(res.body.chatId)!;
    expect(chat.chat_kind).toBe('draft');
    expect(chat.template_id).toBe('smm-specialist');
    expect(chat.title).toBe('AI SMM-спеціаліст');
    expect(chat.use_case_preamble).toContain('Instagram');
    expect(chat.agent).toBe('openclaw/default');
  });

  it('returns 404 for unknown templateId', async () => {
    const res = await request(app)
      .post('/templates/activate')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ templateId: 'no-such-template', answers: {} });

    expect(res.status).toBe(404);
  });

  it('renders firstHint and template badge on the new chat page', async () => {
    const activate = await request(app)
      .post('/templates/activate')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        templateId: 'smm-specialist',
        answers: { platform: 'Instagram', count: '5', tone: 'Дружній' },
      });

    const page = await request(app).get(`/chats/${activate.body.chatId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('пости про каву на тиждень');
    expect(page.text).toContain('chat-template-badge');
  });

  it('falls back to openclaw/default when manifest agentId is unavailable', async () => {
    listAgentsMock.mockResolvedValueOnce([{ id: 'code' }]);
    const agent = await resolveAgentLabel('openclaw/ghost-agent');
    expect(agent).toBe('openclaw/default');

    const res = await request(app)
      .post('/templates/activate')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ templateId: 'daily-briefing', answers: { focus: 'sales' } });

    expect(res.status).toBe(200);
    expect(chats.get(res.body.chatId)!.agent).toBe('openclaw/default');
  });

  it('appends the MCP setup playbook to the preamble for MCP roles', async () => {
    const res = await request(app)
      .post('/templates/activate')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ templateId: 'notion-assistant', answers: { task: 'find notes' } });

    expect(res.status).toBe(200);
    const chat = chats.get(res.body.chatId)!;
    // the role's own prompt is still substituted...
    expect(chat.use_case_preamble).toContain('find notes');
    // ...and the auto-generated MCP playbook is appended (real CLI: `set`, not `add`)
    expect(chat.use_case_preamble).toContain('openclaw mcp list');
    expect(chat.use_case_preamble).toContain(
      `openclaw mcp set notion '{"url":"https://mcp.notion.com/mcp","transport":"streamable-http","auth":"oauth"}'`,
    );
    expect(chat.use_case_preamble).not.toContain('openclaw mcp login');
  });
});

describe('POST /templates/create', () => {
  it('proxies a new template to iClaw-cloud with full AI instructions', async () => {
    const res = await request(app)
      .post('/templates/create')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        title: 'HubSpot Sales',
        promptTemplate: 'You are a sales bot. Use HubSpot API v3 for deals.',
        category: 'Sales',
      });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('HubSpot Sales');
    expect(res.body.id).toBeTruthy();
    const list = await catalog.list();
    const row = list.find((t) => t.title === 'HubSpot Sales');
    expect(row?.promptTemplate).toContain('HubSpot API');
    expect(row?.agentId).toBe('openclaw/default');
  });
});
