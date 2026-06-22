import { describe, it, expect } from 'vitest';

import {
  shrinkOldToolOutputs,
  toolResultVerdict,
  normalizePlanSteps,
  clampTimerMinutes,
  clampTimerSeconds,
  normalizeCalendarEntries,
  normalizeReminder,
  isParallelSafeTool,
  makeLimiter,
  parseVerifierVerdict,
  buildVerifierEvidence,
  type Message,
} from '../../packages/iclaw-runtime/src/agent/loop';

/** Build a tool-result row the way the agent loop stores them. */
function toolMsg(content: string): Message {
  return { role: 'tool', content, tool_call_id: 'x' } as unknown as Message;
}

describe('normalizePlanSteps (update_plan tool)', () => {
  it('keeps valid steps and preserves order + status', () => {
    const out = normalizePlanSteps([
      { step: 'Research competitors', status: 'done' },
      { step: 'Draft the brief', status: 'in_progress' },
      { step: 'Send for review', status: 'pending' },
    ]);
    expect(out).toEqual([
      { step: 'Research competitors', status: 'done' },
      { step: 'Draft the brief', status: 'in_progress' },
      { step: 'Send for review', status: 'pending' },
    ]);
  });

  it('coerces an unknown/missing status to pending and trims the step text', () => {
    const out = normalizePlanSteps([
      { step: '  Do a thing  ', status: 'wat' },
      { step: 'No status here' },
    ]);
    expect(out).toEqual([
      { step: 'Do a thing', status: 'pending' },
      { step: 'No status here', status: 'pending' },
    ]);
  });

  it('drops malformed / empty entries', () => {
    const out = normalizePlanSteps([
      null,
      'a bare string',
      { status: 'done' }, // no step
      { step: '   ', status: 'done' }, // blank step
      { step: 'Real step', status: 'done' },
    ]);
    expect(out).toEqual([{ step: 'Real step', status: 'done' }]);
  });

  it('returns [] for non-array input and clamps very long lists/text', () => {
    expect(normalizePlanSteps('nope' as unknown)).toEqual([]);
    expect(normalizePlanSteps(undefined)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ step: `s${i}`, status: 'pending' }));
    expect(normalizePlanSteps(many)).toHaveLength(20);
    const long = normalizePlanSteps([{ step: 'x'.repeat(500), status: 'done' }]);
    expect(long[0]!.step.length).toBe(200);
    expect(long[0]!.step.endsWith('…')).toBe(true);
  });
});

describe('normalizeCalendarEntries (update_calendar tool)', () => {
  it('keeps valid entries with date + text, defaults status to draft', () => {
    const out = normalizeCalendarEntries([
      { date: '2026-06-15', text: 'Launch teaser', platform: 'Instagram', status: 'idea' },
      { date: '2026-06-16', text: 'Behind the scenes' },
    ]);
    expect(out).toEqual([
      { date: '2026-06-15', text: 'Launch teaser', platform: 'Instagram', status: 'idea' },
      { date: '2026-06-16', text: 'Behind the scenes', platform: '', status: 'draft' },
    ]);
  });
  it('drops bad dates / empty text and coerces an unknown status to draft (never "posted")', () => {
    const out = normalizeCalendarEntries([
      { date: 'tuesday', text: 'nope' }, // bad date
      { date: '2026-06-15', text: '' }, // empty text
      { date: '2026-06-15', text: 'ok', status: 'posted' }, // can't post → draft
      { date: '2026-06-15', text: 'ok2', status: 'scheduled' }, // → draft
    ]);
    expect(out).toEqual([
      { date: '2026-06-15', text: 'ok', platform: '', status: 'draft' },
      { date: '2026-06-15', text: 'ok2', platform: '', status: 'draft' },
    ]);
  });
  it('returns [] for non-array and clamps the batch + long text', () => {
    expect(normalizeCalendarEntries('x' as unknown)).toEqual([]);
    const many = Array.from({ length: 80 }, () => ({ date: '2026-06-15', text: 'p' }));
    expect(normalizeCalendarEntries(many)).toHaveLength(60);
    const long = normalizeCalendarEntries([{ date: '2026-06-15', text: 'y'.repeat(500) }]);
    expect(long[0]!.text.length).toBe(300);
  });
});

describe('normalizeReminder (set_reminder tool)', () => {
  it('dedupes + sorts lead_days far→near and keeps event/date/recurring', () => {
    const r = normalizeReminder({ event: "Mom's birthday", date: '2026-06-20', lead_days: [3, 14, 7, 7], recurring: 'yearly' });
    expect(r).toEqual({ event: "Mom's birthday", date: '2026-06-20', leadDays: [14, 7, 3], recurring: 'yearly' });
  });
  it('defaults lead_days to [1] and recurring to none', () => {
    const r = normalizeReminder({ event: 'Friend party', date: '2026-07-01' });
    expect(r).toEqual({ event: 'Friend party', date: '2026-07-01', leadDays: [1], recurring: 'none' });
  });
  it('rejects missing event or a bad date', () => {
    expect(normalizeReminder({ event: '', date: '2026-06-20' })).toBeNull();
    expect(normalizeReminder({ event: 'X', date: 'June 20' })).toBeNull();
    expect(normalizeReminder({ date: '2026-06-20' })).toBeNull();
    expect(normalizeReminder('nope' as unknown)).toBeNull();
  });
  it('clamps out-of-range lead_days and caps the count', () => {
    const r = normalizeReminder({ event: 'X', date: '2026-06-20', lead_days: [400, -5, 2] });
    expect(r!.leadDays).toEqual([2]); // 400 (>365) and -5 dropped
  });
});

describe('clampTimerMinutes (set_timer tool)', () => {
  it('rounds and accepts a valid minute count', () => {
    expect(clampTimerMinutes(5)).toBe(5);
    expect(clampTimerMinutes(5.4)).toBe(5);
    expect(clampTimerMinutes('30')).toBe(30);
  });
  it('caps at 24h (1440) and rejects sub-minute / invalid input', () => {
    expect(clampTimerMinutes(99999)).toBe(1440);
    expect(clampTimerMinutes(0)).toBeNull();
    expect(clampTimerMinutes(-3)).toBeNull();
    expect(clampTimerMinutes('soon')).toBeNull();
    expect(clampTimerMinutes(undefined)).toBeNull();
    expect(clampTimerMinutes(NaN)).toBeNull();
  });
});

describe('clampTimerSeconds (set_timer tool — seconds granularity)', () => {
  it('prefers seconds and clamps to the 5s…24h range', () => {
    expect(clampTimerSeconds(30, undefined)).toBe(30);
    expect(clampTimerSeconds(10.6, undefined)).toBe(11);
    expect(clampTimerSeconds(1, undefined)).toBe(5); // floor 5s
    expect(clampTimerSeconds(999999, undefined)).toBe(86_400); // 24h cap
  });
  it('falls back to minutes×60 when seconds is absent/invalid', () => {
    expect(clampTimerSeconds(undefined, 2)).toBe(120);
    expect(clampTimerSeconds('soon', 1)).toBe(60);
    expect(clampTimerSeconds(0, 5)).toBe(300);
  });
  it('returns null when neither is usable', () => {
    expect(clampTimerSeconds(undefined, undefined)).toBeNull();
    expect(clampTimerSeconds('nope', 'nope')).toBeNull();
    expect(clampTimerSeconds(0, 0)).toBeNull();
  });
});

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

  it('with a recall store: stashes the full body by message-index id (lossless)', () => {
    const big = toolMsg('IMPORTANT FINDINGS\n' + 'detail line\n'.repeat(2_000));
    const filler = () => toolMsg('z'.repeat(2_000));
    // keepFirst=2, keepLast=3 → only the middle (index 2) gets stubbed.
    const messages: Message[] = [filler(), filler(), big, filler(), filler(), filler()];
    const store = new Map<string, string>();
    shrinkOldToolOutputs(messages, store);
    const stubbed = String((messages[2] as { content?: unknown }).content);
    expect(stubbed).toContain('omitted to save context');
    expect(stubbed).toContain('recall_tool_output');
    expect(stubbed).toContain('id "2"'); // keyed by the tool message's array index
    // The full body is retrievable from the store — compaction is lossless.
    expect(store.get('2')).toContain('IMPORTANT FINDINGS');
    expect((store.get('2') ?? '').length).toBeGreaterThan(1_000);
  });

  it('without a store: falls back to the "re-run" stub (no regression)', () => {
    const filler = () => toolMsg('z'.repeat(3_000));
    const messages: Message[] = [filler(), filler(), toolMsg('y'.repeat(6_000)), filler(), filler(), filler()];
    shrinkOldToolOutputs(messages);
    const stubbed = String((messages[2] as { content?: unknown }).content);
    expect(stubbed).toContain('re-run the tool');
    expect(stubbed).not.toContain('recall_tool_output');
  });
});

describe('isParallelSafeTool (#5 in-round parallelism allowlist)', () => {
  it('allows only idempotent, side-effect-free reads', () => {
    for (const t of ['web_search', 'web_fetch', 'read_file', 'read_summary', 'list_files', 'search_files', 'social_search', 'recall_tool_output']) {
      expect(isParallelSafeTool(t)).toBe(true);
    }
  });

  it('keeps mutating / stateful / control-flow tools sequential', () => {
    for (const t of ['write_file', 'edit_file', 'run_command', 'check_job', 'generate_image', 'edit_image', 'show_image', 'analyze_link', 'browser_open', 'browser_read', 'create_task', 'update_plan', 'set_timer', 'deep_research', 'verify']) {
      expect(isParallelSafeTool(t)).toBe(false);
    }
  });

  it('defaults an unknown / future tool to sequential (allowlist, not blocklist)', () => {
    expect(isParallelSafeTool('some_new_tool')).toBe(false);
    expect(isParallelSafeTool('')).toBe(false);
  });
});

describe('makeLimiter (bounded concurrency)', () => {
  it('never runs more than `limit` fns at once and still resolves all', async () => {
    const limit = 3;
    const run = makeLimiter(limit);
    let active = 0;
    let peak = 0;
    const task = () => run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    });
    const results = await Promise.all(Array.from({ length: 12 }, task));
    expect(results).toHaveLength(12);
    expect(results.every(Boolean)).toBe(true);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(1); // genuinely concurrent, not serialized
  });
});

describe('parseVerifierVerdict (#1 independent verification)', () => {
  it('parses a clean pass verdict', () => {
    expect(parseVerifierVerdict('{"verdict":"pass","issues":""}')).toEqual({ verdict: 'pass', issues: '' });
  });

  it('parses a revise verdict and keeps the issues', () => {
    const v = parseVerifierVerdict('{"verdict":"revise","issues":"revenue $9B not in sources"}');
    expect(v.verdict).toBe('revise');
    expect(v.issues).toContain('revenue');
  });

  it('strips ```json fences and surrounding prose', () => {
    const v = parseVerifierVerdict('Here is my check:\n```json\n{"verdict":"revise","issues":"dead link"}\n```\n');
    expect(v.verdict).toBe('revise');
    expect(v.issues).toBe('dead link');
  });

  it('joins an array of issues', () => {
    const v = parseVerifierVerdict('{"verdict":"revise","issues":["a","b"]}');
    expect(v.verdict).toBe('revise');
    expect(v.issues).toBe('a; b');
  });

  it('fails OPEN (→ pass) on malformed / empty / non-JSON output', () => {
    for (const raw of ['', 'not json at all', '{broken', '{"verdict":']) {
      expect(parseVerifierVerdict(raw)).toEqual({ verdict: 'pass', issues: '' });
    }
  });

  it('downgrades a "revise" with no stated issue to pass (nothing actionable)', () => {
    expect(parseVerifierVerdict('{"verdict":"revise","issues":""}')).toEqual({ verdict: 'pass', issues: '' });
  });
});

describe('buildVerifierEvidence', () => {
  it('returns empty when there is nothing to check against', () => {
    expect(buildVerifierEvidence([])).toBe('');
    expect(buildVerifierEvidence(['', '   '])).toBe('');
  });

  it('includes results newest-first', () => {
    const ev = buildVerifierEvidence(['oldest', 'middle', 'newest']);
    expect(ev.indexOf('newest')).toBeLessThan(ev.indexOf('oldest'));
  });

  it('caps the evidence size', () => {
    const big = ['a'.repeat(5_000), 'b'.repeat(5_000), 'c'.repeat(5_000)];
    expect(buildVerifierEvidence(big, 6_000).length).toBeLessThanOrEqual(6_000);
  });
});
