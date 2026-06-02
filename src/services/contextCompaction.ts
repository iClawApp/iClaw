/**
 * Context compaction — "never clear the chat, just compress old turns".
 *
 * Each chat's full transcript lives permanently in the `messages` table. For
 * the model's context window we build a bounded view:
 *
 *     [rolling summary of older turns] + [last N turns verbatim] + [new message]
 *
 * The summary is produced by a cheap model (config.summaryModel) and cached in
 * `chat_summaries`, rebuilt incrementally as the chat grows. Old context is
 * therefore compressed, never dropped — full detail is always recoverable from
 * the DB. Used by Ask directly, and to seed Work/Secure runtime sessions.
 */
import { db } from '../db/database';
import { messages } from './store';
import { loadOpenRouterConfig } from './config';
import { complete, type OpenRouterMessage } from './openRouter';

/** Keep this many most-recent messages verbatim; older ones get summarized. */
const RECENT_VERBATIM_COUNT = 16;
/** Don't compact until there are clearly "old" turns beyond the verbatim window. */
const MIN_OLDER_TO_SUMMARIZE = 4;
/** Clip each old message to this many chars when feeding the summarizer. */
const SUMMARIZE_PER_MSG_CHARS = 2000;
/** Cap the generated summary length. */
const SUMMARY_MAX_TOKENS = 900;

interface SummaryRow {
  up_to_message_id: number;
  summary: string;
}

function getSummaryRow(chatId: number): SummaryRow | undefined {
  return db
    .prepare('SELECT up_to_message_id, summary FROM chat_summaries WHERE chat_id = ?')
    .get(chatId) as SummaryRow | undefined;
}

function upsertSummaryRow(chatId: number, upToId: number, summary: string): void {
  db.prepare(
    `INSERT INTO chat_summaries (chat_id, up_to_message_id, summary, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET
       up_to_message_id = excluded.up_to_message_id,
       summary = excluded.summary,
       updated_at = excluded.updated_at`,
  ).run(chatId, upToId, summary);
}

interface TurnMsg { id: number; role: string; content: string }

function toModelMsg(m: TurnMsg): OpenRouterMessage {
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.replace(/\s+$/, '') };
}

function formatForSummary(msgs: TurnMsg[]): string {
  return msgs
    .map((m) => {
      const who = m.role === 'assistant' ? 'Assistant' : 'User';
      let text = m.content.trim();
      if (text.length > SUMMARIZE_PER_MSG_CHARS) text = text.slice(0, SUMMARIZE_PER_MSG_CHARS) + '…';
      return `${who}: ${text}`;
    })
    .join('\n\n');
}

const SUMMARY_SYSTEM_PROMPT = [
  'You compress conversation history into a concise, information-dense summary.',
  'Preserve: facts, user preferences and decisions, established context, names,',
  'numbers, file/work state, and any open threads or unfinished tasks.',
  'Merge the existing summary with the new messages into one updated summary.',
  'Do not add commentary, greetings, or meta text — output only the summary.',
].join(' ');

/**
 * Produce (or extend) the summary covering `older`. Incremental: re-summarizes
 * only the messages added since the cached summary. Best-effort — returns the
 * previous (possibly stale) summary, or null, if the model call fails.
 */
async function getOrBuildSummary(chatId: number, older: TurnMsg[], boundaryId: number): Promise<string | null> {
  const row = getSummaryRow(chatId);
  if (row && row.up_to_message_id >= boundaryId) return row.summary;

  const prevSummary = row?.summary ?? '';
  const newOlder = row ? older.filter((m) => m.id > row.up_to_message_id) : older;
  if (newOlder.length === 0) return prevSummary || null;

  const cfg = loadOpenRouterConfig();
  if (!cfg.apiKey) return prevSummary || null;

  try {
    const summary = (await complete({
      model: cfg.summaryModel,
      temperature: 0,
      maxTokens: SUMMARY_MAX_TOKENS,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Existing summary:\n${prevSummary || '(none yet)'}\n\n` +
            `New messages to fold in:\n${formatForSummary(newOlder)}\n\n` +
            'Return the updated summary.',
        },
      ],
    })).trim();
    if (!summary) return prevSummary || null;
    upsertSummaryRow(chatId, boundaryId, summary);
    return summary;
  } catch {
    return prevSummary || null; // degrade: keep stale summary rather than fail the turn
  }
}

/**
 * Build a compacted history for a chat: messages with id < beforeMsgId, as
 * [summary?] + [recent verbatim]. Small chats are returned verbatim (no call).
 */
export async function buildCompactedHistory(chatId: number, beforeMsgId: number): Promise<OpenRouterMessage[]> {
  const all = messages
    .listByChat(chatId)
    .filter((m) => m.id < beforeMsgId && (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ id: m.id, role: m.role, content: m.content }));

  if (all.length <= RECENT_VERBATIM_COUNT + MIN_OLDER_TO_SUMMARIZE) {
    return all.map(toModelMsg);
  }

  const recent = all.slice(-RECENT_VERBATIM_COUNT);
  const older = all.slice(0, -RECENT_VERBATIM_COUNT);
  const boundaryId = older[older.length - 1].id;

  const summary = await getOrBuildSummary(chatId, older, boundaryId);
  const out: OpenRouterMessage[] = [];
  if (summary) {
    out.push({ role: 'system', content: `Summary of earlier conversation (compacted):\n${summary}` });
  }
  for (const m of recent) out.push(toModelMsg(m));
  return out;
}
