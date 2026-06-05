/**
 * Pure helpers — no mocks needed.
 *
 * These cover the slice-based resolver that fixed the bug where
 * `canonicalAssistantText` walked unbounded backward and could surface a
 * previous turn's assistant row when the current user row wasn't yet in
 * the gateway's chat.history snapshot.
 */
import { describe, expect, it } from 'vitest';
import {
  extractAssistantText,
  extractSourceReplyFromMessageToolResult,
  extractTurnUsage,
  resolveFromHistorySlice,
  sliceFromLastUser,
  type HistoryMessageLike,
} from '../../src/services/turnReply';

describe('extractAssistantText', () => {
  it('returns the string for a string content', () => {
    expect(extractAssistantText('hello')).toBe('hello');
  });

  it('joins all type=text parts', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: 'a' },
        { type: 'image', url: 'x' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('returns empty string for null / non-array non-string', () => {
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText(undefined)).toBe('');
    expect(extractAssistantText({} as unknown)).toBe('');
    expect(extractAssistantText(42 as unknown)).toBe('');
  });

  it('ignores non-object parts safely', () => {
    expect(
      extractAssistantText([null, { type: 'text', text: 'kept' }, 'string-part']),
    ).toBe('kept');
  });
});

describe('extractSourceReplyFromMessageToolResult', () => {
  function messageToolRow(payload: unknown): HistoryMessageLike {
    return {
      role: 'toolResult',
      toolName: 'message',
      content: [{ type: 'toolResult', content: JSON.stringify(payload) }],
    };
  }

  it('returns sourceReply.text when present', () => {
    const row = messageToolRow({
      sourceReply: { text: 'authoritative answer' },
    });
    expect(extractSourceReplyFromMessageToolResult(row)).toBe(
      'authoritative answer',
    );
  });

  it('falls back to `message` field when sourceReply absent', () => {
    const row = messageToolRow({ message: 'plain message' });
    expect(extractSourceReplyFromMessageToolResult(row)).toBe('plain message');
  });

  it('prefers sourceReply.text over message field', () => {
    const row = messageToolRow({
      sourceReply: { text: 'preferred' },
      message: 'fallback',
    });
    expect(extractSourceReplyFromMessageToolResult(row)).toBe('preferred');
  });

  it('reads from `text` if `content` is missing', () => {
    const row: HistoryMessageLike = {
      role: 'toolResult',
      toolName: 'message',
      content: [
        {
          type: 'toolResult',
          text: JSON.stringify({ sourceReply: { text: 'via-text' } }),
        },
      ],
    };
    expect(extractSourceReplyFromMessageToolResult(row)).toBe('via-text');
  });

  it('returns null for non-message tool', () => {
    const row: HistoryMessageLike = {
      role: 'toolResult',
      toolName: 'bash',
      content: [{ type: 'toolResult', content: '{"sourceReply":{"text":"x"}}' }],
    };
    expect(extractSourceReplyFromMessageToolResult(row)).toBeNull();
  });

  it('returns null for non-toolResult role', () => {
    expect(
      extractSourceReplyFromMessageToolResult({
        role: 'assistant',
        toolName: 'message',
        content: 'whatever',
      }),
    ).toBeNull();
  });

  it('returns null for blank sourceReply.text (treated as empty)', () => {
    const row = messageToolRow({ sourceReply: { text: '   ' } });
    expect(extractSourceReplyFromMessageToolResult(row)).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    const row: HistoryMessageLike = {
      role: 'toolResult',
      toolName: 'message',
      content: [{ type: 'toolResult', content: '{not-json' }],
    };
    expect(extractSourceReplyFromMessageToolResult(row)).toBeNull();
  });

  it('returns null when content is not an array', () => {
    expect(
      extractSourceReplyFromMessageToolResult({
        role: 'toolResult',
        toolName: 'message',
        content: '{"sourceReply":{"text":"x"}}',
      }),
    ).toBeNull();
  });
});

describe('resolveFromHistorySlice', () => {
  it('prefers message-tool sourceReply over assistant text', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'self-action status note' },
      {
        role: 'toolResult',
        toolName: 'message',
        content: [
          {
            type: 'toolResult',
            content: JSON.stringify({
              sourceReply: { text: 'real answer' },
            }),
          },
        ],
      },
      { role: 'assistant', content: 'projected canonical' },
    ];
    expect(resolveFromHistorySlice(slice)).toBe('real answer');
  });

  it('returns last assistant text when no message-tool toolResult', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'first' },
      { role: 'toolResult', toolName: 'bash', content: [] },
      { role: 'assistant', content: 'last' },
    ];
    expect(resolveFromHistorySlice(slice)).toBe('last');
  });

  it('returns empty string for an empty slice', () => {
    expect(resolveFromHistorySlice([])).toBe('');
  });

  it('returns empty string when slice has no assistant or message-tool rows', () => {
    expect(
      resolveFromHistorySlice([
        { role: 'toolResult', toolName: 'bash', content: [] },
        { role: 'toolResult', toolName: 'shell', content: [] },
      ]),
    ).toBe('');
  });

  it('skips assistant rows with blank text', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'real text' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '   ' },
    ];
    expect(resolveFromHistorySlice(slice)).toBe('real text');
  });

  it('does NOT cross out of the slice — does not look at rows the caller excluded', () => {
    // Caller already sliced. Older rows are not visible to us.
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'current turn assistant' },
    ];
    // No previous-turn data — only what was passed.
    expect(resolveFromHistorySlice(slice)).toBe('current turn assistant');
  });
});

describe('sliceFromLastUser', () => {
  it('returns rows after the last user row', () => {
    const history: HistoryMessageLike[] = [
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'old asst' },
      { role: 'user', content: 'current user' },
      { role: 'assistant', content: 'current asst' },
      { role: 'toolResult', toolName: 'message', content: [] },
    ];
    const slice = sliceFromLastUser(history);
    expect(slice.length).toBe(2);
    expect((slice[0].content as string)).toBe('current asst');
  });

  it('returns the whole history if no user row exists', () => {
    const history: HistoryMessageLike[] = [
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 'b' },
    ];
    expect(sliceFromLastUser(history).length).toBe(2);
  });

  it('returns empty when last row is the user row', () => {
    expect(
      sliceFromLastUser([
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
      ]),
    ).toEqual([]);
  });

  it('handles a fresh-session empty history', () => {
    expect(sliceFromLastUser([])).toEqual([]);
  });
});

describe('resolveFromHistorySlice — chat #23 regression', () => {
  // Exact shape from the OpenClaw jsonl for the user turn at
  // 2026-05-21T21:29:22Z. Without the slice-anchor, the unbounded walk
  // could backtrack into the previous turn and surface a 36-minute-old
  // assistant ("Важливий нюанс…"). With slice + last-user anchor + the
  // message-tool preference, the resolver returns the 2510-char canonical
  // самарі that the agent actually sent.
  it('returns full самарі text from message tool sourceReply', () => {
    const samari = 'Ось самарі для іншої AI:\n\n```\nЗадача:...```';
    const slice: HistoryMessageLike[] = [
      { role: 'toolResult', toolName: 'bash', content: [] },
      { role: 'assistant', content: '' },
      { role: 'toolResult', toolName: 'bash', content: [] },
      {
        role: 'toolResult',
        toolName: 'message',
        content: [
          {
            type: 'toolResult',
            content: JSON.stringify({
              status: 'ok',
              deliveryStatus: 'sent',
              sourceReplyDeliveryMode: 'message_tool_only',
              sourceReply: { text: samari },
            }),
          },
        ],
      },
      // status-note assistant arrives a few ms after the tool result,
      // and the projected canonical assistant arrives ~900ms later
      // (when chat:state=final fires, the second may not be in history yet).
      { role: 'assistant', content: 'Самарі відправив у чат.' },
    ];
    expect(resolveFromHistorySlice(slice)).toBe(samari);
  });
});

describe('extractTurnUsage', () => {
  it('returns nulls when no assistant row carries usage', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'toolResult', content: [] },
    ];
    expect(extractTurnUsage(slice)).toEqual({ tokens: null, cached: null });
  });

  it('prefers an explicit total and reads cache-read tokens', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', usage: { total_tokens: 1234, cache_read_input_tokens: 200 } },
    ];
    expect(extractTurnUsage(slice)).toEqual({ tokens: 1234, cached: 200 });
  });

  it('falls back to input + output when no total is present (camelCase)', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'a', usage: { inputTokens: 100, outputTokens: 23, cacheRead: 10 } },
    ];
    expect(extractTurnUsage(slice)).toEqual({ tokens: 123, cached: 10 });
  });

  it('sums usage across the multiple assistant segments of a tool-loop turn', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'preamble', usage: { total_tokens: 100, cacheRead: 5 } },
      { role: 'toolResult', content: [] },
      { role: 'assistant', content: 'final', usage: { input_tokens: 40, output_tokens: 10 } },
    ];
    expect(extractTurnUsage(slice)).toEqual({ tokens: 150, cached: 5 });
  });

  it('ignores non-object / malformed usage', () => {
    const slice: HistoryMessageLike[] = [
      { role: 'assistant', content: 'a', usage: 'nope' },
      { role: 'assistant', content: 'b', usage: { foo: 'bar' } },
    ];
    expect(extractTurnUsage(slice)).toEqual({ tokens: null, cached: null });
  });
});
