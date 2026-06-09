/**
 * Pure helpers for picking the user-facing assistant reply out of a turn's
 * history slice. No I/O, no side effects — call sites supply the slice.
 *
 * Why a separate module:
 *
 *  - These helpers are reused by `openclawWs.runTurn` (resolves authoritative
 *    text at turn completion) and were previously inlined in `chatRunner`,
 *    walking the *entire* unbounded history backward to the first `user`
 *    row. That ran past the current turn's boundary when the current user
 *    row hadn't yet been committed to gateway history, surfacing the
 *    PREVIOUS turn's assistant text in the UI.
 *
 *  - Pinning the slice to "rows after the current turn's user row"
 *    (computed in openclawWs from chat.history with a high limit) makes the
 *    resolution turn-scoped and stops the walk from leaking across runs.
 *
 *  - With `sourceReplyDeliveryMode: "message_tool_only"`, the canonical
 *    answer is in the `message` tool's `sourceReply.text` — committed as a
 *    `toolResult` row BEFORE the agent's status-note assistant row, so a
 *    forward-scanning resolver sees it deterministically in the slice
 *    (no settling-loop needed for the common case).
 */

export interface HistoryMessageLike {
  role: string;
  content: unknown;
  toolName?: string;
  timestamp?: number;
  isError?: boolean;
  /**
   * Per-message token usage, present on assistant rows in OpenClaw's
   * UI-normalized `chat.history`. The gateway sanitizes it to a flat object
   * of numeric fields (field names vary by provider — see `pickUsageTotal`).
   */
  usage?: unknown;
}

/** Pull a finite number from a usage object under the first matching key. */
function firstNumber(u: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = u[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Total tokens for one assistant row's `usage`. Prefers an explicit total;
 * otherwise sums input + output. Field names cover OpenClaw's sanitized set
 * (camelCase, snake_case, and Anthropic-style). Returns `null` when the row
 * carries no usable usage numbers.
 */
function pickUsageTotal(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const total = firstNumber(u, ['total_tokens', 'totalTokens', 'total']);
  if (total != null) return total;
  const input = firstNumber(u, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']);
  const output = firstNumber(u, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']);
  if (input == null && output == null) return null;
  return (input ?? 0) + (output ?? 0);
}

/** Prompt tokens served from cache for one assistant row's `usage`, or null. */
function pickUsageCached(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  return firstNumber(usage as Record<string, unknown>, [
    'cacheRead',
    'cache_read_input_tokens',
    'cachedTokens',
    'cached_tokens',
  ]);
}

/**
 * Sum token usage across every assistant row in a turn-scoped slice. A native
 * tool loop commits multiple assistant segments per turn (preamble + post-tool
 * reply), each with its own `usage`, so the turn's true cost is their sum.
 * Returns `null` for a field when no assistant row reported it.
 */
export function extractTurnUsage(slice: HistoryMessageLike[]): {
  tokens: number | null;
  cached: number | null;
} {
  let tokens: number | null = null;
  let cached: number | null = null;
  for (const row of slice) {
    if (row.role !== 'assistant') continue;
    const t = pickUsageTotal(row.usage);
    if (t != null) tokens = (tokens ?? 0) + t;
    const c = pickUsageCached(row.usage);
    if (c != null) cached = (cached ?? 0) + c;
  }
  return { tokens, cached };
}

/**
 * Flatten an assistant row's `content` (string OR `[{type:'text', text}]`)
 * into its text. Returns `''` for empty / non-text parts.
 */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (p): p is { type?: string; text?: string } =>
        p !== null && typeof p === 'object',
    )
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/**
 * If `row` is the `message` tool's toolResult, return its `sourceReply.text`
 * (or the `message` field as a secondary form). Returns `null` otherwise,
 * including when the JSON body is malformed.
 *
 * The tool encodes its payload as a JSON string under `content` (and
 * duplicates it under `text`). See OpenClaw's `message` tool protocol.
 */
export function extractSourceReplyFromMessageToolResult(
  row: HistoryMessageLike,
): string | null {
  const isMessageTool = row.role === 'toolResult' && row.toolName === 'message';
  if (!isMessageTool) return null;
  const content = row.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; content?: unknown; text?: unknown };
    if (p.type !== 'toolResult') continue;
    const raw =
      typeof p.content === 'string'
        ? p.content
        : typeof p.text === 'string'
          ? p.text
          : '';
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        sourceReply?: { text?: unknown };
        message?: unknown;
      };
      const sourceReplyText = parsed?.sourceReply?.text;
      if (
        typeof sourceReplyText === 'string' &&
        sourceReplyText.trim().length > 0
      ) {
        return sourceReplyText;
      }
      if (
        typeof parsed?.message === 'string' &&
        parsed.message.trim().length > 0
      ) {
        return parsed.message;
      }
    } catch {
      /* not JSON — skip this part */
    }
  }
  return null;
}

/**
 * Scan a turn-scoped history slice and return the best user-facing text.
 *
 * Priority (highest first):
 *   1. The LAST `message` toolResult's `sourceReply.text` in the slice.
 *      This is the canonical channel reply OpenClaw sends when the agent
 *      runs in `message_tool_only` mode.
 *   2. The LAST non-empty assistant text row in the slice.
 *   3. `''` (caller falls back to streamed-buffer text).
 *
 * `slice` MUST be the rows AFTER the current turn's user row (or `[]`).
 * Walking backwards bounded to the slice is what stops the resolver from
 * leaking into a previous turn — earlier `canonicalAssistantText` walked
 * the global history and could grab a 30-minute-old assistant row.
 */
export function resolveFromHistorySlice(slice: HistoryMessageLike[]): string {
  let assistantFallback = '';
  for (let i = slice.length - 1; i >= 0; i--) {
    const row = slice[i]!;
    const sourceReply = extractSourceReplyFromMessageToolResult(row);
    if (sourceReply) return sourceReply;
    if (row.role === 'assistant' && !assistantFallback) {
      const text = extractAssistantText(row.content);
      if (text.trim().length > 0) assistantFallback = text;
    }
  }
  return assistantFallback;
}

/**
 * From a full history (chronologically ordered, oldest first), return the
 * slice AFTER the last `user` row. That last user row anchors the current
 * turn: every row after it belongs to the in-flight (or just-finished)
 * agent run.
 *
 * If no user row is found (fresh session, history fetch capped below the
 * first turn), returns the whole history — best-effort. Callers may then
 * still get a useful answer via `resolveFromHistorySlice`.
 */
export function sliceFromLastUser(
  history: HistoryMessageLike[],
): HistoryMessageLike[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') return history.slice(i + 1);
  }
  return history.slice();
}
