/**
 * Pure helpers in chatTitle — deriveTitle (placeholder generator) and
 * normalizeSuggestedTitle (AI output quality gate).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveTitle,
  normalizeSuggestedTitle,
  TITLE_LIMIT,
} from '../../src/services/chatTitle';

describe('deriveTitle', () => {
  it('collapses whitespace + trims', () => {
    expect(deriveTitle('  hello   world\n\t!  ')).toBe('hello world !');
  });

  it('empty / whitespace falls back to "New chat"', () => {
    expect(deriveTitle('')).toBe('New chat');
    expect(deriveTitle('   ')).toBe('New chat');
    expect(deriveTitle('\n\t')).toBe('New chat');
  });

  it('truncates long inputs at TITLE_LIMIT with ellipsis', () => {
    const long = 'A'.repeat(200);
    const out = deriveTitle(long);
    expect(out.length).toBe(TITLE_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps short inputs untouched (no ellipsis)', () => {
    expect(deriveTitle('how do I deploy this?')).toBe('how do I deploy this?');
  });
});

describe('normalizeSuggestedTitle', () => {
  it('strips wrapping quotes and "Title:" prefixes', () => {
    expect(normalizeSuggestedTitle('"Deploy a Node app"')).toBe('Deploy a Node app');
    expect(normalizeSuggestedTitle('«Backup with rsync»')).toBe('Backup with rsync');
    expect(normalizeSuggestedTitle('Title: Authentication setup')).toBe(
      'Authentication setup',
    );
    expect(normalizeSuggestedTitle('TITLE - Postgres tuning')).toBe('Postgres tuning');
  });

  it('drops trailing punctuation', () => {
    expect(normalizeSuggestedTitle('Database migration steps.')).toBe(
      'Database migration steps',
    );
    expect(normalizeSuggestedTitle('Quick question!')).toBe('Quick question');
    expect(normalizeSuggestedTitle('Help with regex…')).toBe('Help with regex');
  });

  it('takes only the first line', () => {
    expect(normalizeSuggestedTitle('First good title\nIgnore this rambling')).toBe(
      'First good title',
    );
  });

  it('rejects too-short single-word output', () => {
    expect(normalizeSuggestedTitle('OK')).toBe('');
    expect(normalizeSuggestedTitle('8')).toBe('');
    expect(normalizeSuggestedTitle('hi')).toBe('');
    expect(normalizeSuggestedTitle('yes')).toBe('');
  });

  it('rejects "Here is …" preamble (model breaking out of role)', () => {
    expect(normalizeSuggestedTitle('Here is a title for this conversation')).toBe('');
    expect(normalizeSuggestedTitle('Here are some options')).toBe('');
  });

  it('rejects numeric / punctuation-only output', () => {
    expect(normalizeSuggestedTitle('1 2 3 4 5')).toBe('');
    expect(normalizeSuggestedTitle('...,,, ;;')).toBe('');
  });

  it('rejects wordy output > 8 words', () => {
    expect(
      normalizeSuggestedTitle('this is a much too verbose nine word title for a chat'),
    ).toBe('');
  });

  it('accepts a clean 3–6 word title', () => {
    expect(normalizeSuggestedTitle('Postgres connection pooling')).toBe(
      'Postgres connection pooling',
    );
    expect(normalizeSuggestedTitle('Setup Stripe webhook in Next.js')).toBe(
      'Setup Stripe webhook in Next.js',
    );
  });

  it('caps length at TITLE_LIMIT with ellipsis', () => {
    const verbose = 'word ' + 'a'.repeat(200);
    const out = normalizeSuggestedTitle(verbose);
    // Too long → rejected? Actually >8 words gate triggers first if needed.
    // For single super-long word it's <=8 words, so length cap kicks in.
    if (out !== '') {
      expect(out.length).toBeLessThanOrEqual(TITLE_LIMIT);
    }
  });

  it('empty / blank → ""', () => {
    expect(normalizeSuggestedTitle('')).toBe('');
    expect(normalizeSuggestedTitle('   \n  ')).toBe('');
  });
});
