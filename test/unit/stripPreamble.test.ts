/**
 * stripAgentSelfActionPreamble — removes OpenClaw's "I sent X in chat"
 * narration when `visibleReplies: "message_tool"` is configured.
 */
import { describe, expect, it } from 'vitest';
import { stripAgentSelfActionPreamble } from '../../src/services/chatRunner';

describe('stripAgentSelfActionPreamble', () => {
  it('strips Ukrainian "Надіслав у чат…" preamble when real content follows', () => {
    const input =
      'Надіслав у чат рекомендацію по архітектурі.\n\n' +
      'Коротко моя позиція: для iClaw-cloud я б справді йшов у cloudflared-схему, ' +
      'але не як 100% protection, а як нормальне зменшення surface area.';
    const out = stripAgentSelfActionPreamble(input);
    expect(out.startsWith('Коротко моя позиція')).toBe(true);
    expect(out).not.toContain('Надіслав');
  });

  it('strips English "Sent X in chat" preamble', () => {
    const input =
      "Sent X in chat with summary.\n\n" +
      "Long enough real answer continues here with more than fifty characters to be substantive.";
    const out = stripAgentSelfActionPreamble(input);
    expect(out.startsWith('Long enough real answer')).toBe(true);
  });

  it('strips Russian "Отправил…" preamble', () => {
    const input =
      'Отправил в чат рекомендации.\n\n' +
      'А вот развернутый ответ который превышает порог в пятьдесят символов сразу же.';
    const out = stripAgentSelfActionPreamble(input);
    expect(out.startsWith('А вот развернутый')).toBe(true);
  });

  it('does NOT strip when no preamble pattern at start', () => {
    const input = 'Так. По факту там таке:\n\nGitHub: ...';
    expect(stripAgentSelfActionPreamble(input)).toBe(input);
  });

  it('does NOT strip when stripping would leave too little content', () => {
    const input = 'Надіслав у чат відповідь.\n\nДякую.';
    // After stripping: "Дякую." — 6 chars < 50. Keep the original.
    expect(stripAgentSelfActionPreamble(input)).toBe(input);
  });

  it('handles empty / whitespace input safely', () => {
    expect(stripAgentSelfActionPreamble('')).toBe('');
    expect(stripAgentSelfActionPreamble('   ')).toBe('   ');
  });

  it('requires the preamble to end with a period + blank line', () => {
    // No blank line → not stripped.
    const input = 'Надіслав у чат відповідь — ось вона:\nКоротко моя позиція по архітектурі...';
    expect(stripAgentSelfActionPreamble(input)).toBe(input);
  });

  it('caps preamble length at 200 chars to avoid greedy matches', () => {
    const longPreamble =
      'Sent ' + 'a'.repeat(300) + '.\n\n' +
      'Real answer below that should not be reached because the preamble is too long to match safely.';
    // The regex caps at 200 chars in the preamble, so it shouldn't match the 300-char prefix.
    expect(stripAgentSelfActionPreamble(longPreamble)).toBe(longPreamble);
  });
});
