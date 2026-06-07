import { describe, expect, it } from 'vitest';
import {
  toolActivityLabel,
  toolActivityDetail,
  lifecycleActivityLabel,
} from '../../src/services/toolLabels';

describe('toolActivityLabel', () => {
  // Generic heuristics for gateway tool names (use names NOT in the exact
  // iClaw-runtime switch, which is covered separately below).
  it('maps search-ish names', () => {
    expect(toolActivityLabel('code_search')).toBe('Searching…');
    expect(toolActivityLabel('grep')).toBe('Searching…');
    expect(toolActivityLabel('lookup_lib')).toBe('Searching…');
    expect(toolActivityLabel('BrowsePages')).toBe('Searching…');
  });

  it('maps edit-ish names', () => {
    expect(toolActivityLabel('apply_changes')).toBe('Editing file…');
    expect(toolActivityLabel('writeText')).toBe('Editing file…');
    expect(toolActivityLabel('patch')).toBe('Editing file…');
    expect(toolActivityLabel('save')).toBe('Editing file…');
  });

  it('maps read-ish names', () => {
    expect(toolActivityLabel('tail_log')).toBe('Reading file…');
    expect(toolActivityLabel('cat')).toBe('Reading file…');
    expect(toolActivityLabel('head')).toBe('Reading file…');
    expect(toolActivityLabel('view_file')).toBe('Reading file…');
  });

  it('maps shell-ish names', () => {
    expect(toolActivityLabel('bash')).toBe('Running command…');
    expect(toolActivityLabel('exec')).toBe('Running command…');
    expect(toolActivityLabel('shell')).toBe('Running command…');
    expect(toolActivityLabel('terminal_run')).toBe('Running command…');
  });

  // iClaw runtime tools get specific labels (exact match, checked before the
  // generic heuristics — so social_search doesn't collapse to "Searching…").
  it('maps iClaw runtime tools to specific labels', () => {
    expect(toolActivityLabel('social_search')).toBe('Searching social media…');
    expect(toolActivityLabel('web_search')).toBe('Searching the web…');
    expect(toolActivityLabel('web_fetch')).toBe('Reading the web…');
    expect(toolActivityLabel('read_summary')).toBe('Skimming a file…');
    expect(toolActivityLabel('analyze_link')).toBe('Analyzing the link…');
    expect(toolActivityLabel('show_image')).toBe('Sharing an image…');
    expect(toolActivityLabel('search_files')).toBe('Searching files…');
    expect(toolActivityLabel('list_files')).toBe('Listing files…');
    expect(toolActivityLabel('read_file')).toBe('Reading a file…');
    expect(toolActivityLabel('write_file')).toBe('Writing a file…');
    expect(toolActivityLabel('edit_file')).toBe('Editing a file…');
    expect(toolActivityLabel('run_command')).toBe('Running a command…');
  });

  it('maps thinking-ish names', () => {
    expect(toolActivityLabel('think_step')).toBe('Thinking…');
    expect(toolActivityLabel('reasoning')).toBe('Thinking…');
    expect(toolActivityLabel('plan')).toBe('Thinking…');
  });

  it('maps listing-ish names', () => {
    expect(toolActivityLabel('ls')).toBe('Listing files…');
    expect(toolActivityLabel('list_dir')).toBe('Listing files…');
    expect(toolActivityLabel('glob_match')).toBe('Listing files…');
  });

  it('falls back to humanised version of the raw name', () => {
    expect(toolActivityLabel('weird_custom_thing')).toMatch(/Weird custom thing…/i);
    expect(toolActivityLabel('SomeTool')).toMatch(/^Some Tool…|^SomeTool…/i);
    expect(toolActivityLabel('')).toBe('…');
  });
});

describe('toolActivityDetail', () => {
  it('pulls the query / command / path', () => {
    expect(toolActivityDetail('web_search', { query: 'openclaw traffic', count: 5 })).toBe('openclaw traffic');
    expect(toolActivityDetail('run_command', { command: 'ls -la' })).toBe('ls -la');
    expect(toolActivityDetail('read_file', { path: '/a/b/c.ts' })).toBe('/a/b/c.ts');
  });

  it('reduces a URL to host + path (trailing slash trimmed)', () => {
    expect(toolActivityDetail('web_fetch', { url: 'https://github.com/Zijian-Ni/awesome-ai-agents-2026' }))
      .toBe('github.com/Zijian-Ni/awesome-ai-agents-2026');
    expect(toolActivityDetail('web_fetch', { url: 'https://x.com/' })).toBe('x.com');
  });

  it('returns undefined when there is nothing useful', () => {
    expect(toolActivityDetail('show_image', {})).toBeUndefined();
    expect(toolActivityDetail('web_search', { query: '   ' })).toBeUndefined();
    expect(toolActivityDetail('web_fetch', null)).toBeUndefined();
    expect(toolActivityDetail('web_fetch', 'oops')).toBeUndefined();
  });

  it('caps long detail at 70 chars', () => {
    const d = toolActivityDetail('web_search', { query: 'a'.repeat(120) });
    expect(d).toHaveLength(70);
    expect(d?.endsWith('…')).toBe(true);
  });
});

describe('lifecycleActivityLabel', () => {
  it('maps known phases', () => {
    expect(lifecycleActivityLabel('thinking')).toBe('Thinking…');
    expect(lifecycleActivityLabel('start')).toBe('Starting…');
    expect(lifecycleActivityLabel('end')).toBe('Finishing…');
  });
  it('capitalises unknown phases', () => {
    expect(lifecycleActivityLabel('aborted')).toBe('Aborted…');
    expect(lifecycleActivityLabel('error')).toBe('Error…');
    expect(lifecycleActivityLabel('failed')).toBe('Failed…');
  });
});
