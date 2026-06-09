import { openclawWs } from './openclawWs';
import { complete, openRouterEnabled } from './openRouter';
import { loadOpenRouterConfig } from './config';

export const TITLE_LIMIT = 60;
/**
 * Time budget for the title sub-request. We fire it in the background alongside
 * the main turn; it doesn't block the assistant reply. 2 min is generous because
 * OpenClaw routes through a full agent run.
 */
export const TITLE_BUDGET_MS = 120_000;

/**
 * Prompt designed to keep the agent in "label this conversation" mode instead
 * of "answer the question" mode. We pack everything into a single user message
 * because OpenClaw replaces our `system` content with its own agent prompt.
 */
function buildTitlePrompt(userMessage: string): string {
  const cleaned = userMessage.replace(/\s+/g, ' ').trim().slice(0, 800);
  return [
    'TASK: Suggest a short chat-history title for the message below.',
    '',
    'Rules:',
    '- Output ONLY the title, on a single line.',
    '- 3 to 6 words.',
    '- Describe what the user is asking about — do NOT answer the question.',
    '- No quotes, no trailing punctuation, no "Title:" prefix.',
    '- Use the same language as the user.',
    '- Never just output a number, a code snippet, a path, or a single word.',
    '',
    'User message:',
    cleaned,
    '',
    'Title:',
  ].join('\n');
}

export function deriveTitle(firstMessage: string): string {
  const single = firstMessage.replace(/\s+/g, ' ').trim();
  if (!single) return 'New chat';
  return single.length > TITLE_LIMIT ? single.slice(0, TITLE_LIMIT - 1) + '…' : single;
}

/**
 * Trim noise, then validate against a strict quality gate. Returns '' if the
 * suggestion is unusable (so the caller keeps the placeholder).
 */
export function normalizeSuggestedTitle(raw: string): string {
  let t = raw
    .trim()
    .split('\n')[0]!
    .trim()
    // strip wrapping quotes / fancy quotes
    .replace(/^["'«»“”`]+|["'«»“”`]+$/g, '')
    // strip "Title:" / "title -" prefixes
    .replace(/^title\s*[:\-—]\s*/i, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    // strip trailing punctuation
    .replace(/[.,;!?…]+$/g, '')
    .trim();

  if (!t) return '';

  const words = t.split(/\s+/).filter(Boolean);

  // Quality gates — reject obvious garbage like "8", "OK", "yes"
  if (words.length < 2) return '';
  if (words.length > 8) return '';
  if (t.length < 6) return '';
  if (/^[\d\s.,:;!?-]+$/.test(t)) return ''; // numeric / punctuation only
  if (t.toLowerCase().startsWith('here is') || t.toLowerCase().startsWith('here are')) return '';

  if (t.length > TITLE_LIMIT) t = t.slice(0, TITLE_LIMIT - 1) + '…';
  return t;
}

function sleep<T = null>(ms: number, value: T | null = null): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * `model` is the chat's agent label (e.g. "openclaw/default"). We strip the
 * "openclaw/" prefix and create a throw-away session under that agent so the
 * title call doesn't pollute the real chat's transcript.
 */
function modelToAgentId(model: string): string {
  if (!model || model === 'openclaw' || model === 'openclaw/default') return 'main';
  return model.startsWith('openclaw/') ? model.slice('openclaw/'.length) : model;
}

/**
 * Cheap single-shot title via OpenRouter. Returns null on failure or a rejected
 * suggestion so the caller can fall back to the OpenClaw path.
 */
async function suggestChatTitleViaOpenRouter(userMessage: string): Promise<string | null> {
  try {
    const cfg = loadOpenRouterConfig();
    const text = await complete({
      model: cfg.titleModel,
      messages: [{ role: 'user', content: buildTitlePrompt(userMessage) }],
      temperature: 0.3,
      maxTokens: 32,
    });
    const cleaned = normalizeSuggestedTitle(text);
    if (!cleaned) {
      console.warn('[chatTitle] openrouter rejected suggestion:', JSON.stringify(text.slice(0, 120)));
      return null;
    }
    return cleaned;
  } catch (err) {
    console.warn(
      '[chatTitle] openrouter failed, will fall back to OpenClaw:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Title via a throw-away OpenClaw agent session — the original path, kept as
 * the fallback when OpenRouter is unconfigured (or its call failed).
 */
async function suggestChatTitleViaOpenClaw(opts: {
  model: string;
  userMessage: string;
}): Promise<string | null> {
  const agentId = modelToAgentId(opts.model);
  let sessionKey: string | null = null;
  try {
    const session = await openclawWs.createSession({ agentId });
    sessionKey = session.key;
    let acc = '';
    await openclawWs.runTurn({
      sessionKey: session.key,
      message: buildTitlePrompt(opts.userMessage),
      onEvent: (ev) => {
        if (ev.type === 'text-delta') acc += ev.text;
        else if (ev.type === 'text-final') acc = ev.text || acc;
      },
    });
    const cleaned = normalizeSuggestedTitle(acc);
    if (!cleaned) {
      console.warn(
        '[chatTitle] rejected suggestion:',
        JSON.stringify(acc.slice(0, 120)),
      );
      return null;
    }
    return cleaned;
  } catch (err) {
    console.error('[chatTitle] suggest failed', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (sessionKey) {
      // Best-effort cleanup so we don't pile up throw-away sessions.
      openclawWs.deleteSession(sessionKey).catch(() => {});
    }
  }
}

/**
 * Suggest a chat title. Prefers OpenRouter (cheap, no agent run) when a key is
 * configured; falls back to a throw-away OpenClaw session when OpenRouter is
 * unconfigured or its call fails/returns an unusable suggestion.
 */
export async function suggestChatTitle(opts: {
  model: string;
  userMessage: string;
}): Promise<string | null> {
  if (openRouterEnabled()) {
    const viaOpenRouter = await suggestChatTitleViaOpenRouter(opts.userMessage);
    if (viaOpenRouter) return viaOpenRouter;
    // null → OpenRouter unusable this time; fall through to OpenClaw.
  }
  return suggestChatTitleViaOpenClaw(opts);
}

/** Race title generation against a hard budget; null on timeout. */
export async function suggestChatTitleWithTimeout(
  opts: Parameters<typeof suggestChatTitle>[0],
  timeoutMs: number = TITLE_BUDGET_MS,
): Promise<string | null> {
  return Promise.race([suggestChatTitle(opts), sleep<string>(timeoutMs)]);
}
