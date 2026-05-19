import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDbPath, displayPath, resolveDbPath } from '../../src/paths';

describe('paths', () => {
  const prev = process.env.DB_PATH;

  afterEach(() => {
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
  });

  it('defaultDbPath points under ~/.iclaw/data', () => {
    expect(defaultDbPath()).toBe(join(homedir(), '.iclaw', 'data', 'iclaw.db'));
  });

  it('resolveDbPath uses default when unset', () => {
    delete process.env.DB_PATH;
    expect(resolveDbPath()).toBe(defaultDbPath());
  });

  it('displayPath shortens home directory to ~', () => {
    const p = join(homedir(), '.iclaw', 'data', 'iclaw.db');
    expect(displayPath(p)).toBe('~/.iclaw/data/iclaw.db');
  });
});
