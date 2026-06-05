import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the three collaborators so we can assert routing without real network.
vi.mock('../../src/services/openRouter', () => ({
  openRouterEnabled: vi.fn(),
  complete: vi.fn(),
  isOpenRouterFailure: (e: unknown) =>
    /^openrouter:/i.test(e instanceof Error ? e.message : String(e)),
}));
vi.mock('../../src/services/config', () => ({
  loadOpenRouterConfig: () => ({ summaryModel: 'cheap/model' }),
}));
vi.mock('../../src/services/openclawWs', () => {
  const runTurn = vi.fn(async (opts: { onEvent: (ev: { type: string; text: string }) => void }) => {
    opts.onEvent({ type: 'text-final', text: 'openclaw-result' });
  });
  return {
    openclawWs: {
      createSession: vi.fn(async () => ({ key: 'k1' })),
      runTurn,
      deleteSession: vi.fn(async () => {}),
    },
  };
});

import { runSubtaskTurn } from '../../src/services/subtaskLlm';
import { openRouterEnabled, complete } from '../../src/services/openRouter';
import { openclawWs } from '../../src/services/openclawWs';

const mockEnabled = openRouterEnabled as unknown as ReturnType<typeof vi.fn>;
const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe('runSubtaskTurn routing', () => {
  it('uses OpenRouter (cheap model) when configured', async () => {
    mockEnabled.mockReturnValue(true);
    mockComplete.mockResolvedValue('openrouter-result');

    const out = await runSubtaskTurn('hi', { maxTokens: 100 });

    expect(out).toBe('openrouter-result');
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0][0]).toMatchObject({
      model: 'cheap/model',
      maxTokens: 100,
    });
    expect(openclawWs.createSession).not.toHaveBeenCalled();
  });

  it('passes an optional system prompt through to OpenRouter', async () => {
    mockEnabled.mockReturnValue(true);
    mockComplete.mockResolvedValue('ok');
    await runSubtaskTurn('user text', { system: 'be terse' });
    const messages = mockComplete.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(messages[1]).toEqual({ role: 'user', content: 'user text' });
  });

  it('falls back to OpenClaw when OpenRouter is not configured', async () => {
    mockEnabled.mockReturnValue(false);
    const out = await runSubtaskTurn('hi');
    expect(out).toBe('openclaw-result');
    expect(mockComplete).not.toHaveBeenCalled();
    expect(openclawWs.createSession).toHaveBeenCalledTimes(1);
    expect(openclawWs.deleteSession).toHaveBeenCalledTimes(1);
  });

  it('falls back to OpenClaw when the OpenRouter call throws', async () => {
    mockEnabled.mockReturnValue(true);
    mockComplete.mockRejectedValue(new Error('openrouter: HTTP 500'));
    const out = await runSubtaskTurn('hi');
    expect(out).toBe('openclaw-result');
    expect(openclawWs.createSession).toHaveBeenCalledTimes(1);
  });

  it('returns OpenRouter output verbatim even when empty (no double-spend fallback)', async () => {
    mockEnabled.mockReturnValue(true);
    mockComplete.mockResolvedValue('');
    const out = await runSubtaskTurn('hi');
    expect(out).toBe('');
    expect(openclawWs.createSession).not.toHaveBeenCalled();
  });
});
