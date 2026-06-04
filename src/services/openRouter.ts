/**
 * Direct OpenRouter client — the FIRST non-OpenClaw LLM path in iClaw.
 *
 * Used for the lightweight, tool-less features that should NOT spin up a full
 * OpenClaw agent run:
 *   - Chat titles   → a cheap single-shot completion.
 *   - Background sub-tasks (fact extraction, fact compaction, skill review) via
 *     services/subtaskLlm.ts (preferred over a throwaway OpenClaw turn).
 *   - Speech-to-text → audio transcription via a multimodal model.
 *
 * Talks the OpenAI-compatible `/chat/completions` endpoint OpenRouter exposes.
 * Streaming responses are parsed here (server-sent events over `fetch`) and the
 * caller re-emits deltas through `wsHub` — the same shape `openclawWs.runTurn`
 * uses, so the browser stream renderer is identical for both backends.
 *
 * No SDK / extra deps: Node 18+ (we run 25) ships global `fetch` + streams.
 *
 * Availability is config-driven: when `OPENROUTER_API_KEY` is unset, the
 * features that REQUIRE OpenRouter (Ask, STT) are hidden/refused, and title
 * generation falls back to the OpenClaw path. See `loadOpenRouterConfig`.
 */

import { loadOpenRouterConfig } from './config';

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** True when an API key is configured — gates Ask/STT and title routing. */
export function openRouterEnabled(): boolean {
  return Boolean(loadOpenRouterConfig().apiKey);
}

/**
 * Failures from the OpenRouter bridge are tagged with this prefix so callers
 * (chatRunner) can distinguish them from OpenClaw gateway failures and surface
 * a sensible user message instead of leaking raw text.
 */
function fail(message: string): never {
  throw new Error(`openrouter: ${message}`);
}

export function isOpenRouterFailure(err: unknown): boolean {
  const t = (err instanceof Error ? err.message : String(err)).trim();
  return /^openrouter:/i.test(t);
}

function buildHeaders(apiKey: string, referer: string, appTitle: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  // OpenRouter uses these for app attribution / rankings. Optional, harmless.
  if (referer) h['HTTP-Referer'] = referer;
  if (appTitle) h['X-Title'] = appTitle;
  return h;
}

interface ChatCompletionOpts {
  messages: OpenRouterMessage[];
  /** Defaults to the configured Ask model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Abort the in-flight request (Stop button). */
  signal?: AbortSignal;
}

/**
 * Non-streaming completion. Returns the full assistant text. Used for titles
 * and any short single-shot call.
 */
export async function complete(opts: ChatCompletionOpts): Promise<string> {
  const cfg = loadOpenRouterConfig();
  if (!cfg.apiKey) fail('no API key configured (set OPENROUTER_API_KEY)');
  const model = opts.model ?? cfg.askModel;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(cfg.apiKey, cfg.referer, cfg.appTitle),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: false,
        thinking: { type: 'disabled' },
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  return json?.choices?.[0]?.message?.content ?? '';
}

interface StreamCompletionOpts extends ChatCompletionOpts {
  /** Fires for every text delta as it streams in. */
  onDelta: (text: string) => void;
}

/**
 * Streaming completion. Calls `onDelta` for each token chunk and resolves with
 * the full accumulated text. Parses OpenRouter's SSE stream (`data: {json}`
 * lines, terminated by `data: [DONE]`).
 */
export async function streamComplete(opts: StreamCompletionOpts): Promise<string> {
  const cfg = loadOpenRouterConfig();
  if (!cfg.apiKey) fail('no API key configured (set OPENROUTER_API_KEY)');
  const model = opts.model ?? cfg.askModel;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(cfg.apiKey, cfg.referer, cfg.appTitle),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: true,
        // Disable extended thinking — Ask mode is for quick answers, not deep reasoning
        thinking: { type: 'disabled' },
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  if (!res.body) fail('no response body to stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  // SSE frames are separated by a blank line. We accumulate across chunks
  // because a single network chunk can split a `data:` line mid-JSON.
  const consumeLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') return true;
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        opts.onDelta(delta);
      }
    } catch {
      // OpenRouter sends `: OPENROUTER PROCESSING` keep-alive comments and the
      // occasional partial line — ignore anything that isn't valid JSON.
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (consumeLine(line)) {
          await reader.cancel().catch(() => {});
          return full;
        }
      }
    }
    // Flush any trailing buffered line (stream ended without final newline).
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    reader.releaseLock?.();
  }
  return full;
}

/**
 * Transcribe audio to text via a multimodal model. Sends the clip as an
 * `input_audio` content part to /chat/completions and asks for a verbatim
 * transcript. Returns the transcript (possibly empty). Throws `openrouter:` on
 * failure.
 *
 * NOTE: accepted audio formats depend on the model. Gemini-class models take
 * common containers, but the browser's MediaRecorder output varies (webm/opus
 * on Chrome, mp4/aac on Safari). If a model rejects the upload, point
 * `ICLAW_STT_MODEL` at one that accepts that container.
 */
export async function transcribeAudio(opts: {
  audioBase64: string;
  /** Container hint for the model: "webm" | "mp3" | "wav" | "m4a" | "ogg" | … */
  format: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const cfg = loadOpenRouterConfig();
  if (!cfg.apiKey) fail('no API key configured (set OPENROUTER_API_KEY)');
  const model = opts.model ?? cfg.sttModel;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(cfg.apiKey, cfg.referer, cfg.appTitle),
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Transcribe this audio verbatim. Output ONLY the transcript text — ' +
                  'no preamble, quotes, or commentary. If there is no speech, output nothing.',
              },
              { type: 'input_audio', input_audio: { data: opts.audioBase64, format: opts.format } },
            ],
          },
        ],
      }),
      signal: opts.signal,
    });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  return (json?.choices?.[0]?.message?.content ?? '').trim();
}

export interface KeyValidation {
  /** The key authenticates against OpenRouter. */
  valid: boolean;
  /** USD remaining if known; null when unlimited/unknown. */
  remaining: number | null;
  /** Optional key label from OpenRouter. */
  label?: string;
  /** Machine-readable reason when invalid: 'empty' | 'unauthorized' | 'http' | 'network'. */
  reason?: string;
}

/**
 * Validate an OpenRouter key WITHOUT storing it — used by onboarding/Settings to
 * catch a dead, mistyped, or zero-balance key before it silently breaks the
 * first chat. Hits `/auth/key` (cheap, no completion spend) with the candidate
 * key and reports validity + remaining credit. Network failures are reported as
 * `valid: false, reason: 'network'` so the UI can say "couldn't verify" rather
 * than wrongly rejecting a good key.
 */
export async function validateKey(key: string, signal?: AbortSignal): Promise<KeyValidation> {
  const trimmed = key.trim();
  if (!trimmed) return { valid: false, remaining: null, reason: 'empty' };

  const cfg = loadOpenRouterConfig();
  const headers = buildHeaders(trimmed, cfg.referer, cfg.appTitle);

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/auth/key`, { headers, signal });
  } catch {
    return { valid: false, remaining: null, reason: 'network' };
  }
  if (res.status === 401 || res.status === 403) {
    return { valid: false, remaining: null, reason: 'unauthorized' };
  }
  if (!res.ok) return { valid: false, remaining: null, reason: 'http' };

  const j = (await res.json().catch(() => null)) as {
    data?: { label?: string; usage?: number; limit?: number | null; limit_remaining?: number | null };
  } | null;
  const d = j?.data ?? {};
  const usage = Number(d.usage ?? 0);
  const limit = d.limit == null ? null : Number(d.limit);
  const remaining =
    d.limit_remaining == null ? (limit != null ? Math.max(limit - usage, 0) : null) : Number(d.limit_remaining);
  return { valid: true, remaining, label: d.label };
}

export interface OpenRouterUsage {
  /** USD spent so far on this key/account. */
  usage: number;
  /** USD credit limit, or null when there is none. */
  limit: number | null;
  /** USD remaining, or null when unknown/unlimited. */
  remaining: number | null;
  /** Optional key label from OpenRouter. */
  label?: string;
  isFreeTier?: boolean;
}

/**
 * Fetch spend/credit info for the configured key, for the Settings usage
 * readout. Tries `/credits` (purchased credits + total usage) first, then
 * falls back to `/auth/key` (usage + limit + label). Throws `openrouter:` on
 * failure so the caller can show a friendly "couldn't load usage" note.
 */
export async function fetchUsage(signal?: AbortSignal): Promise<OpenRouterUsage> {
  const cfg = loadOpenRouterConfig();
  if (!cfg.apiKey) fail('no API key configured (add it in Settings)');
  const headers = buildHeaders(cfg.apiKey, cfg.referer, cfg.appTitle);

  // Preferred: /credits → { data: { total_credits, total_usage } }.
  try {
    const res = await fetch(`${cfg.baseUrl}/credits`, { headers, signal });
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as {
        data?: { total_credits?: number; total_usage?: number };
      } | null;
      const d = j?.data;
      if (d && (typeof d.total_usage === 'number' || typeof d.total_credits === 'number')) {
        const usage = Number(d.total_usage ?? 0);
        const credits = Number(d.total_credits ?? 0);
        const limit = credits > 0 ? credits : null;
        const remaining = limit != null ? Math.max(limit - usage, 0) : null;
        return { usage, limit, remaining };
      }
    }
  } catch (err) {
    if (signal?.aborted) fail('aborted');
    // fall through to /auth/key
  }

  // Fallback: /auth/key → { data: { label, usage, limit, limit_remaining, is_free_tier } }.
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/auth/key`, { headers, signal });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = (await res.json().catch(() => null)) as {
    data?: {
      label?: string;
      usage?: number;
      limit?: number | null;
      limit_remaining?: number | null;
      is_free_tier?: boolean;
    };
  } | null;
  const d = j?.data ?? {};
  const usage = Number(d.usage ?? 0);
  const limit = d.limit == null ? null : Number(d.limit);
  const remaining =
    d.limit_remaining == null
      ? limit != null
        ? Math.max(limit - usage, 0)
        : null
      : Number(d.limit_remaining);
  return { usage, limit, remaining, label: d.label, isFreeTier: d.is_free_tier };
}
