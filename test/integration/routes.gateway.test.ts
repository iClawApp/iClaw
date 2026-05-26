/**
 * /api/gateway/* — thin proxies for OpenClaw RPCs that the UI needs.
 * Verifies shape normalisation and error → 502.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb } from '../helpers/db';

const openclawWsMock = {
  listAgents: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ key: '', sessionId: '' })),
  deleteSession: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
  abortRun: vi.fn(async () => undefined),
  runTurn: vi.fn(async () => ({ runId: '', text: '' })),
  resolveExecApproval: vi.fn(async () => undefined),
  listModels: vi.fn(async () => ({ models: [] })),
  listCommands: vi.fn(async () => ({ commands: [] })),
  patchSession: vi.fn(async () => ({})),
  subscribeSessions: vi.fn(async () => undefined),
};
vi.mock('../../src/services/openclawWs', () => ({ openclawWs: openclawWsMock }));
vi.mock('../../src/services/gatewayWs', () => ({
  gatewayWs: {
    request: vi.fn(async () => ({})),
    onFrame: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    ensureConnected: vi.fn(async () => undefined),
    resetConnection: vi.fn(),
  },
}));
const openclawMock = {
  baseUrl: 'http://127.0.0.1:18789',
  hasToken: true,
  tokenSource: 'test',
  health: vi.fn(async () => true),
};
vi.mock('../../src/services/openclaw', () => ({
  openclaw: openclawMock,
}));
vi.mock('../../src/services/gatewayStart', () => ({
  isLocalhostRequest: () => true,
  queueGatewayStart: vi.fn(async () => ({ ready: true })),
}));

const { createApp } = await import('../../src/app');
const app = createApp();

beforeAll(() => resetTestDb());
afterEach(() => {
  resetTestDb();
  openclawWsMock.listCommands.mockClear();
});

describe('GET /api/gateway/status', () => {
  it('reports gateway health', async () => {
    openclawMock.health.mockResolvedValueOnce(true);
    const res = await request(app).get('/api/gateway/status');
    expect(res.status).toBe(200);
    expect(res.body.up).toBe(true);
  });
});

describe('POST /api/gateway/start', () => {
  it('returns ready when health is already up', async () => {
    openclawMock.health.mockResolvedValue(true);
    const res = await request(app).post('/api/gateway/start');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

describe('GET /api/gateway/commands', () => {
  it('returns command list with stable shape, drops aliasless empties', async () => {
    openclawWsMock.listCommands.mockResolvedValueOnce({
      commands: [
        { name: 'compact', description: 'Compact the session', textAliases: ['/compact', '/c'] },
        { name: '', description: 'no name — dropped' },
        { name: 'new' },
      ],
    });
    const res = await request(app).get('/api/gateway/commands?agent=openclaw/default');
    expect(res.status).toBe(200);
    const names = res.body.commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(['compact', 'new']);
    expect(openclawWsMock.listCommands).toHaveBeenCalledWith({ agentId: 'openclaw/default' });
  });

  it('handles undefined agent param', async () => {
    openclawWsMock.listCommands.mockResolvedValueOnce({ commands: [{ name: 'help' }] });
    const res = await request(app).get('/api/gateway/commands');
    expect(res.status).toBe(200);
    expect(openclawWsMock.listCommands).toHaveBeenCalledWith({ agentId: undefined });
  });
});

