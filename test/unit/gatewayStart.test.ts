import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/services/openclaw', () => ({
  openclaw: {
    health: vi.fn(),
  },
}));

const { openclaw } = await import('../../src/services/openclaw');
const { waitForGatewayHealth } = await import('../../src/services/gatewayStart');

describe('waitForGatewayHealth', () => {
  beforeEach(() => {
    vi.mocked(openclaw.health).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true when health succeeds on first check', async () => {
    vi.mocked(openclaw.health).mockResolvedValueOnce(true);
    await expect(waitForGatewayHealth(5_000, 10)).resolves.toBe(true);
    expect(openclaw.health).toHaveBeenCalledTimes(1);
  });

  it('returns false when health never succeeds', async () => {
    vi.useFakeTimers();
    vi.mocked(openclaw.health).mockResolvedValue(false);
    const p = waitForGatewayHealth(2_500, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toBe(false);
  });
});
