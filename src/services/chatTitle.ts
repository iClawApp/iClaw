import { randomUUID } from 'node:crypto';
import { openclaw } from './openclaw';

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
    .split('\n')[0]
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

export async function suggestChatTitle(opts: {
  model: string;
  userMessage: string;
}): Promise<string | null> {
  try {
    const result = await openclaw.chat({
      model: opts.model,
      // Independent session so it doesn't interfere with the real chat.
      sessionKey: `iclaude-title-${randomUUID()}`,
      maxTokens: 32,
      messages: [{ role: 'user', content: buildTitlePrompt(opts.userMessage) }],
    });
    const cleaned = normalizeSuggestedTitle(result.content);
    if (!cleaned) {
      console.warn(
        '[chatTitle] rejected suggestion:',
        JSON.stringify(result.content.slice(0, 120)),
      );
      return null;
    }
    return cleaned;
  } catch (err) {
    console.error('[chatTitle] suggest failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Race title generation against a hard budget; null on timeout. */
export async function suggestChatTitleWithTimeout(
  opts: Parameters<typeof suggestChatTitle>[0],
  timeoutMs: number = TITLE_BUDGET_MS,
): Promise<string | null> {
  return Promise.race([suggestChatTitle(opts), sleep<string>(timeoutMs)]);
}
