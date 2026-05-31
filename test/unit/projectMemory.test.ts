import { afterEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { projects, projectFacts } from '../../src/services/store';
import {
  applyUseCasePreamble,
  buildGatewayUserMessage,
  isDuplicateFact,
  normalizeForDedup,
  parseExtractedFactLines,
  stripBulletPrefix,
} from '../../src/services/projectMemory';
import { normalizeAgentId } from '../../src/services/chatRunner';

afterEach(() => resetTestDb());

describe('stripBulletPrefix', () => {
  it('strips common bullet markers and surrounding whitespace', () => {
    expect(stripBulletPrefix('  - hello')).toBe('hello');
    expect(stripBulletPrefix('* world')).toBe('world');
    expect(stripBulletPrefix('• check')).toBe('check');
    expect(stripBulletPrefix('   *   spaced')).toBe('spaced');
  });
  it('strips numbered list markers like 1. and 2)', () => {
    expect(stripBulletPrefix('1. first')).toBe('first');
    expect(stripBulletPrefix('2) second')).toBe('second');
    expect(stripBulletPrefix('  12.   third')).toBe('third');
  });
  it('does not strip dashes in the middle of a line', () => {
    expect(stripBulletPrefix('use UTF-8 encoding')).toBe('use UTF-8 encoding');
  });
  it('empty / whitespace inputs return ""', () => {
    expect(stripBulletPrefix('')).toBe('');
    expect(stripBulletPrefix('    ')).toBe('');
  });
});

describe('parseExtractedFactLines', () => {
  it('returns [] for the sentinel "NONE" / variants', () => {
    expect(parseExtractedFactLines('NONE')).toEqual([]);
    expect(parseExtractedFactLines('none.')).toEqual([]);
    expect(parseExtractedFactLines('No facts')).toEqual([]);
    expect(parseExtractedFactLines('nothing')).toEqual([]);
    expect(parseExtractedFactLines('   ')).toEqual([]);
  });
  it('parses bulleted multi-line output', () => {
    const raw = `- Stack: Node.js + Express\n- DB: SQLite via better-sqlite3\n- Frontend: vanilla JS`;
    expect(parseExtractedFactLines(raw)).toEqual([
      'Stack: Node.js + Express',
      'DB: SQLite via better-sqlite3',
      'Frontend: vanilla JS',
    ]);
  });
  it('caps output at 3 lines (drops the rest)', () => {
    const raw = `- one\n- two\n- three\n- four\n- five`;
    expect(parseExtractedFactLines(raw)).toEqual(['one', 'two', 'three']);
  });
  it('truncates lines over 240 chars', () => {
    const long = 'x'.repeat(300);
    const [out] = parseExtractedFactLines(long);
    expect(out.length).toBe(240);
  });
  it('strips bullet AND number prefixes when both are used', () => {
    const raw = `1. - mixed`;
    // First strip removes "1.", second strip removes "- "
    expect(parseExtractedFactLines(raw)).toEqual(['- mixed']);
  });
});

describe('normalizeForDedup', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeForDedup('  Hello   WORLD  ')).toBe('hello world');
    expect(normalizeForDedup('A\nB\tC')).toBe('a b c');
  });
});

describe('isDuplicateFact', () => {
  it('rejects too-short candidates (< 4 chars after normalisation)', () => {
    expect(isDuplicateFact('hi', [])).toBe(true);
    expect(isDuplicateFact('  ', [])).toBe(true);
  });
  it('detects exact duplicates regardless of case + whitespace', () => {
    expect(isDuplicateFact('Backend on Node 18', ['backend  on  node  18'])).toBe(true);
  });
  it('detects substring duplicates only for long-enough strings (>=20 chars)', () => {
    const existing = ['we deploy to vercel for production hosting'];
    expect(isDuplicateFact('deploy to vercel for production', existing)).toBe(true);
    // Short candidate, not a substring match
    expect(isDuplicateFact('vercel', existing)).toBe(false);
  });
  it('returns false when nothing matches', () => {
    expect(isDuplicateFact('Postgres via Supabase', ['Mongo Atlas cluster'])).toBe(false);
  });
});

describe('buildGatewayUserMessage', () => {
  it('returns content unchanged when the project does not exist', () => {
    const out = buildGatewayUserMessage('hello agent', 99999);
    expect(out).toBe('hello agent');
  });

  it('returns content unchanged when project has no facts', () => {
    const p = projects.create('Empty');
    const out = buildGatewayUserMessage('hi there', p.id);
    expect(out).toBe('hi there');
  });

  it('prepends facts block + separator when project has facts', () => {
    const p = projects.create('With Facts');
    projectFacts.append({ projectId: p.id, content: 'Stack: Node + Express' });
    projectFacts.append({ projectId: p.id, content: 'DB: SQLite' });
    const out = buildGatewayUserMessage('please explain X', p.id);
    expect(out).toContain('Project context');
    expect(out).toContain('Stack: Node + Express');
    expect(out).toContain('DB: SQLite');
    expect(out).toContain('---');
    expect(out).toContain('[User message]');
    expect(out).toContain('please explain X');
    // user message must come AFTER the separator
    expect(out.indexOf('please explain X')).toBeGreaterThan(out.indexOf('---'));
  });

  it('respects the token budget — never explodes for hundreds of facts', () => {
    const p = projects.create('Heavy');
    for (let i = 0; i < 80; i++) {
      projectFacts.append({ projectId: p.id, content: `Fact #${i}: ` + 'lorem '.repeat(20) });
    }
    const out = buildGatewayUserMessage('go', p.id);
    // ~1500 token budget × 4 chars = ~6000 chars; allow generous slack.
    expect(out.length).toBeLessThan(8000);
  });

  it('uses most recent facts first (back-to-front insert order)', () => {
    const p = projects.create('Recent');
    projectFacts.append({ projectId: p.id, content: 'OLDEST FACT' });
    projectFacts.append({ projectId: p.id, content: 'MIDDLE FACT' });
    projectFacts.append({ projectId: p.id, content: 'NEWEST FACT' });
    const out = buildGatewayUserMessage('go', p.id);
    // All three should be present in the typical small fact set
    expect(out).toContain('NEWEST FACT');
    // The newest must appear closer to the user message than the oldest
    expect(out.lastIndexOf('NEWEST FACT')).toBeGreaterThan(out.lastIndexOf('OLDEST FACT'));
  });
});

describe('normalizeAgentId', () => {
  it('maps empty / default labels to "main"', () => {
    expect(normalizeAgentId(undefined)).toBe('main');
    expect(normalizeAgentId(null)).toBe('main');
    expect(normalizeAgentId('')).toBe('main');
    expect(normalizeAgentId('openclaw')).toBe('main');
    expect(normalizeAgentId('openclaw/default')).toBe('main');
  });
  it('strips the openclaw/ prefix for other labels', () => {
    expect(normalizeAgentId('openclaw/code')).toBe('code');
    expect(normalizeAgentId('openclaw/research')).toBe('research');
  });
  it('passes through already-bare ids', () => {
    expect(normalizeAgentId('code')).toBe('code');
    expect(normalizeAgentId('custom-agent')).toBe('custom-agent');
  });
});

describe('applyUseCasePreamble', () => {
  it('returns the message unchanged for an empty / whitespace preamble', () => {
    expect(applyUseCasePreamble('', 'hello')).toBe('hello');
    expect(applyUseCasePreamble('   \n  ', 'hello')).toBe('hello');
  });

  it('prepends an authoritative instructions block before the message', () => {
    const out = applyUseCasePreamble('You are an SMM specialist.', 'write a post');
    expect(out).toContain('Operating instructions');
    expect(out).toContain('You are an SMM specialist.');
    expect(out).toContain('write a post');
    // the user message comes AFTER the persona
    expect(out.indexOf('write a post')).toBeGreaterThan(
      out.indexOf('You are an SMM specialist.'),
    );
  });

  it('trims the preamble but preserves the downstream message verbatim', () => {
    const out = applyUseCasePreamble('  Persona  ', 'BODY');
    expect(out).toContain('Persona\n'); // trimmed (no leading/trailing spaces)
    expect(out.endsWith('BODY')).toBe(true); // body preserved at the very end
  });
});
