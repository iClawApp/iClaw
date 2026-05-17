import { describe, expect, it } from 'vitest';
import {
  toolActivityLabel,
  lifecycleActivityLabel,
} from '../../src/services/toolLabels';

describe('toolActivityLabel', () => {
  it('maps search-ish names', () => {
    expect(toolActivityLabel('web_search')).toBe('Searching…');
    expect(toolActivityLabel('grep')).toBe('Searching…');
    expect(toolActivityLabel('lookup_lib')).toBe('Searching…');
    expect(toolActivityLabel('BrowsePages')).toBe('Searching…');
  });

  it('maps edit-ish names', () => {
    expect(toolActivityLabel('edit_file')).toBe('Editing file…');
    expect(toolActivityLabel('writeText')).toBe('Editing file…');
    expect(toolActivityLabel('patch')).toBe('Editing file…');
    expect(toolActivityLabel('save')).toBe('Editing file…');
  });

  it('maps read-ish names', () => {
    expect(toolActivityLabel('read_file')).toBe('Reading file…');
    expect(toolActivityLabel('cat')).toBe('Reading file…');
    expect(toolActivityLabel('head')).toBe('Reading file…');
    expect(toolActivityLabel('view_file')).toBe('Reading file…');
  });

  it('maps shell-ish names', () => {
    expect(toolActivityLabel('bash')).toBe('Running command…');
    expect(toolActivityLabel('exec')).toBe('Running command…');
    expect(toolActivityLabel('shell')).toBe('Running command…');
    expect(toolActivityLabel('run_command')).toBe('Running command…');
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
