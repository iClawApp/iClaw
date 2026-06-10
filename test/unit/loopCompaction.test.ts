import { describe, it, expect } from 'vitest';

import {
  shrinkOldToolOutputs,
  toolResultVerdict,
  type Message,
} from '../../packages/iclaw-runtime/src/agent/loop';

/** Build a tool-result row the way the agent loop stores them. */
function toolMsg(content: string): Message {
  return { role: 'tool', content, tool_call_id: 'x' } as unknown as Message;
}

describe('toolResultVerdict', () => {
  it('prefers an explicit exit marker buried at the end of the output', () => {
    const v = toolResultVerdict(
      'remote: Permission denied\nfatal: unable to access\n[exit code 128 — command FAILED]',
    );
    expect(v).toBe('[exit code 128 — command FAILED]');
  });

  it('prefers the timeout-kill marker', () => {
    const v = toolResultVerdict('partial\n\n[command killed after 60s — it timed out and did NOT finish.]');
    expect(v).toMatch(/^\[command killed after 60s/);
  });

  it('falls back to the first non-empty line', () => {
    expect(toolResultVerdict('\n\nCloned into repo\nmore output')).toBe('Cloned into repo');
  });

  it('clips to 120 chars', () => {
    const v = toolResultVerdict('y'.repeat(500));
    expect(v).toHaveLength(120);
    expect(v.endsWith('…')).toBe(true);
  });
});

describe('shrinkOldToolOutputs', () => {
  it('keeps the verdict line when stubbing a failed command output', () => {
    // Force the compaction gate (>16k total) with many large middle results.
    const failed = toolMsg(
      'lots of stderr noise\n'.repeat(50) + '[exit code 128 — command FAILED]',
    );
    const filler = () => toolMsg('z'.repeat(2_000));
    // 2 protected first + the failed one in the middle + 6 protected last.
    const messages: Message[] = [
      filler(), filler(),
      failed,
      filler(), filler(), filler(), filler(), filler(), filler(),
    ];
    shrinkOldToolOutputs(messages);
    const stubbed = String((messages[2] as { content?: unknown }).content);
    expect(stubbed).toContain('omitted to save context');
    expect(stubbed).toContain('[exit code 128 — command FAILED]');
  });

  it('does not touch anything under the size gate', () => {
    const messages: Message[] = [toolMsg('short'), toolMsg('also short')];
    shrinkOldToolOutputs(messages);
    expect((messages[0] as { content?: unknown }).content).toBe('short');
  });
});
