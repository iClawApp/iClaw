import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Vision-capability gate (packages/iclaw-runtime/src/agent/model-capabilities.ts).
 *
 * The module caches the OpenRouter /models result at module scope, so each test
 * loads a FRESH copy via vi.resetModules() + dynamic import — no cross-test cache
 * bleed. `fetch` is stubbed; no network is ever hit.
 */

const MODELS_BODY = {
  data: [
    { id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'deepseek/deepseek-v4-flash', architecture: { input_modalities: ['text'] } },
    { id: 'a/img-via-modality', architecture: { modality: 'text+image->text' } },
    { id: 'a/text-via-modality', architecture: { modality: 'text->text' } },
  ],
};

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => MODELS_BODY } as unknown as Response));
}
function failFetch() {
  return vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response));
}

async function freshModule() {
  vi.resetModules();
  return import('../../packages/iclaw-runtime/src/agent/model-capabilities');
}

const ENV_KEYS = ['ICLAW_VISION_MODEL', 'ICLAW_VISION_MODELS', 'ICLAW_MODELS_CACHE_TTL_MS'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isVisionModel', () => {
  it('derives capability from input_modalities and the modality string', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { isVisionModel } = await freshModule();
    expect(await isVisionModel('google/gemini-2.5-flash', 'k')).toBe(true);
    expect(await isVisionModel('deepseek/deepseek-v4-flash', 'k')).toBe(false);
    expect(await isVisionModel('a/img-via-modality', 'k')).toBe(true);
    expect(await isVisionModel('a/text-via-modality', 'k')).toBe(false);
    expect(await isVisionModel('a/not-in-registry', 'k')).toBe(false);
  });

  it('honors the ICLAW_VISION_MODELS allowlist without a network call', async () => {
    process.env.ICLAW_VISION_MODELS = 'my/local-vlm, other/vision';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { isVisionModel } = await freshModule();
    expect(await isVisionModel('my/local-vlm', 'k')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (unknown) when the registry fetch fails and nothing is cached', async () => {
    vi.stubGlobal('fetch', failFetch());
    const { isVisionModel } = await freshModule();
    expect(await isVisionModel('deepseek/deepseek-v4-flash', 'k')).toBeNull();
  });
});

describe('resolveTurnModel', () => {
  it('returns the configured model and never hits the network for a text turn', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveTurnModel } = await freshModule();
    const d = await resolveTurnModel({ model: 'deepseek/deepseek-v4-flash', apiKey: 'k', hasImages: false });
    expect(d).toEqual({ model: 'deepseek/deepseek-v4-flash' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes an image turn off a text-only model to the default vision fallback', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { resolveTurnModel } = await freshModule();
    const d = await resolveTurnModel({ model: 'deepseek/deepseek-v4-flash', apiKey: 'k', hasImages: true });
    expect(d.model).toBe('google/gemini-2.5-flash');
    expect(d.switched).toBe(true);
    expect(d.error).toBeUndefined();
  });

  it('leaves an image turn on a vision-capable model untouched', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { resolveTurnModel } = await freshModule();
    const d = await resolveTurnModel({ model: 'google/gemini-2.5-flash', apiKey: 'k', hasImages: true });
    expect(d).toEqual({ model: 'google/gemini-2.5-flash' });
  });

  it('errors when neither the model nor the configured vision fallback can see', async () => {
    process.env.ICLAW_VISION_MODEL = 'deepseek/deepseek-v4-flash'; // text-only
    vi.stubGlobal('fetch', okFetch());
    const { resolveTurnModel } = await freshModule();
    const d = await resolveTurnModel({ model: 'a/not-in-registry', apiKey: 'k', hasImages: true });
    expect(d.error).toMatch(/can't accept images/i);
    expect(d.switched).toBeUndefined();
  });

  it('does not swap when capability is unknown (fetch failed) — lets the turn proceed', async () => {
    vi.stubGlobal('fetch', failFetch());
    const { resolveTurnModel } = await freshModule();
    const d = await resolveTurnModel({ model: 'deepseek/deepseek-v4-flash', apiKey: 'k', hasImages: true });
    expect(d).toEqual({ model: 'deepseek/deepseek-v4-flash' });
  });
});
