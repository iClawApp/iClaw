/**
 * Vision-capability gate for inbound user images.
 *
 * iClaw is OpenRouter-only, so we mirror OpenClaw's approach: read the model's
 * `architecture.input_modalities` from OpenRouter's /models registry to learn
 * whether it can accept image input. When the configured model is text-only and
 * a turn carries images, we transparently route THAT turn to a vision-capable
 * fallback (`ICLAW_VISION_MODEL`); text turns stay on the cheap default and pay
 * no lookup at all.
 *
 * Without this gate both agent loops (Work/Incognito in loop.ts, Secure in
 * secure-runner.ts) send `image_url` blocks to whatever `ICLAW_MODEL` is, and a
 * text-only model (e.g. the default `deepseek/deepseek-v4-flash`) makes
 * OpenRouter return `404 No endpoints found that support image input`.
 *
 * Capability source mirrors OpenClaw (same OpenRouter field); Hermes does the
 * same check off models.dev because it's multi-provider — we don't need that
 * extra dependency since every model we call is an OpenRouter slug.
 */

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** In-memory capability cache TTL. Mirrors Hermes' 1h models.dev cache. */
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.ICLAW_MODELS_CACHE_TTL_MS) || 60 * 60 * 1000);

/**
 * Default vision fallback. Gemini Flash is cheap, supports tool calling, and is
 * already the host-side model for ask/title/stt — so an image turn behaves the
 * same as a text turn, just on a model that can see.
 */
export const DEFAULT_VISION_MODEL = 'google/gemini-2.5-flash';

interface CacheEntry { at: number; vision: Set<string> }
let cache: CacheEntry | null = null;
/** De-dupe concurrent fetches: many image turns can race the first lookup. */
let inflight: Promise<Set<string>> | null = null;

interface ORModel {
  id?: string;
  architecture?: { input_modalities?: unknown; modality?: unknown };
}

/**
 * A model accepts images when `"image"` is in its `input_modalities`, or when
 * its `modality` string ("text+image->text") names image on the INPUT side.
 * This is exactly the derivation OpenClaw uses on the same OpenRouter field.
 */
function modelAcceptsImage(m: ORModel): boolean {
  const arch = m.architecture ?? {};
  const mods = arch.input_modalities;
  if (Array.isArray(mods) && mods.includes('image')) return true;
  const modality = typeof arch.modality === 'string' ? arch.modality : '';
  // "<inputs>-><outputs>" — only the part before "->" is the input side.
  return modality.split('->')[0]?.includes('image') ?? false;
}

async function fetchVisionModels(apiKey: string): Promise<Set<string>> {
  const res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const json = (await res.json()) as { data?: ORModel[] };
  const vision = new Set<string>();
  for (const m of json.data ?? []) {
    if (typeof m.id === 'string' && modelAcceptsImage(m)) vision.add(m.id);
  }
  return vision;
}

/**
 * True / false when we can resolve the model's image capability; null when it's
 * genuinely unknown (network/HTTP failure with no cache to fall back on).
 *
 * A manual allowlist wins first: `ICLAW_VISION_MODELS` (comma-separated slugs)
 * lets a user declare a custom/local model vision-capable without it being in
 * OpenRouter's registry — same escape hatch Hermes exposes via
 * `model.supports_vision`.
 */
export async function isVisionModel(model: string, apiKey: string): Promise<boolean | null> {
  if (!model) return null;
  const allow = (process.env.ICLAW_VISION_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(model)) return true;

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.vision.has(model);

  if (!inflight) {
    inflight = fetchVisionModels(apiKey)
      .then((vision) => {
        cache = { at: Date.now(), vision };
        return vision;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    const vision = await inflight;
    return vision.has(model);
  } catch {
    // Serve a stale cache on failure; otherwise we truly don't know.
    return cache ? cache.vision.has(model) : null;
  }
}

export interface TurnModelDecision {
  /** Model to actually send for THIS turn (possibly the vision fallback). */
  model: string;
  /** Set when the turn carries images but no vision-capable model is available. */
  error?: string;
  /** True when we routed off the configured model to the vision fallback. */
  switched?: boolean;
}

/**
 * Decide which model runs THIS turn. Only image-bearing turns pay the capability
 * lookup; a text turn returns the configured model untouched (zero overhead, no
 * network call).
 *
 *   - configured model sees images          → use it
 *   - capability unknown (lookup failed)     → use it (don't silently swap a
 *                                              possibly-vision model; a 404, if
 *                                              it comes, is explained by
 *                                              describeApiError)
 *   - confirmed text-only + images present   → route to ICLAW_VISION_MODEL
 *                                              (verified vision-capable), or
 *                                              return a clear error if none.
 */
export async function resolveTurnModel(args: {
  model: string;
  apiKey: string;
  hasImages: boolean;
}): Promise<TurnModelDecision> {
  const { model, apiKey, hasImages } = args;
  if (!hasImages) return { model };

  const mainSeesImages = await isVisionModel(model, apiKey);
  if (mainSeesImages !== false) return { model }; // true or unknown → leave as-is

  const visionModel = (process.env.ICLAW_VISION_MODEL ?? '').trim() || DEFAULT_VISION_MODEL;
  if (!visionModel || visionModel === model) {
    return {
      model,
      error:
        `The current model (${model}) can't accept images. Set ICLAW_VISION_MODEL to a ` +
        `vision-capable OpenRouter model (e.g. ${DEFAULT_VISION_MODEL}) to use photos, or remove the attachment.`,
    };
  }

  // Guard against a misconfigured fallback that also can't see (one cached
  // lookup — same /models set). Unknown/true both allow the switch.
  const fallbackSeesImages = await isVisionModel(visionModel, apiKey);
  if (fallbackSeesImages === false) {
    return {
      model,
      error:
        `ICLAW_VISION_MODEL (${visionModel}) also can't accept images — set it to a ` +
        `vision-capable OpenRouter model like ${DEFAULT_VISION_MODEL}.`,
    };
  }

  return { model: visionModel, switched: true };
}
