import { randomUUID } from 'node:crypto';
import { openclaw } from './openclaw';

export const TITLE_LIMIT = 60;
/** After the main reply — title sub-request often needs 15–25s. */
export const TITLE_WAIT_AFTER_REPLY_MS = 25_000;
/** While the main agent runs — optional title from user message only. */
export const TITLE_WAIT_DURING_RUN_MS = 120_000;

const TITLE_SYSTEM =
  'Generate a short chat title (3–6 words max). Output only the title text. Same language as the user. Never copy commands, paths, or the assistant reply.';

export function deriveTitle(firstMessage: string): string {
  const single = firstMessage.replace(/\s+/g, ' ').trim();
  if (!single) return 'New chat';
  return single.length > TITLE_LIMIT ? single.slice(0, TITLE_LIMIT - 1) + '…' : single;
}

export function normalizeSuggestedTitle(raw: string): string {
  let t = raw
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 8) return '';
  if (t.length > TITLE_LIMIT) t = t.slice(0, TITLE_LIMIT - 1) + '…';
  return t;
}

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export async function suggestChatTitle(opts: {
  model: string;
  userMessage: string;
  assistantReply: string;
}): Promise<string | null> {
  const preview = opts.assistantReply.replace(/\s+/g, ' ').trim().slice(0, 280);
  const userPrompt = preview
    ? `User:\n${opts.userMessage.trim().slice(0, 500)}\n\nAssistant (excerpt):\n${preview}`
    : `User message only (no reply yet):\n${opts.userMessage.trim().slice(0, 500)}`;

  try {
    const result = await openclaw.chat({
      model: opts.model,
      sessionKey: `iclaude-title-${randomUUID()}`,
      maxTokens: 32,
      messages: [
        { role: 'system', content: TITLE_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    });
    return normalizeSuggestedTitle(result.content) || null;
  } catch (err) {
    console.error('[chatTitle] suggest failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Race title generation against a short timeout (cheap sub-request, non-blocking UX cap). */
export async function suggestChatTitleWithTimeout(
  opts: Parameters<typeof suggestChatTitle>[0],
  timeoutMs = TITLE_WAIT_AFTER_REPLY_MS,
): Promise<string | null> {
  return Promise.race([suggestChatTitle(opts), sleep(timeoutMs)]);
}
