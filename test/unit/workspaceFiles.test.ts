import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isWithin,
  isSecretFile,
  isInlineSafe,
  resolveServedFile,
} from '../../src/services/workspaceFiles';

describe('isWithin (containment)', () => {
  it('accepts the root itself and files inside it', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d.txt')).toBe(true);
  });
  it('rejects parents, siblings and prefix look-alikes', () => {
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/bc')).toBe(false); // prefix sibling, not a child
    expect(isWithin('/a/b', '/x/y')).toBe(false);
  });
});

describe('isSecretFile (deny-list)', () => {
  it('flags secret-shaped files', () => {
    for (const p of ['/r/.env', '/r/.env.local', '/r/id_rsa', '/r/key.pem', '/r/x.key', '/r/credentials.json', '/r/tokens.json', '/home/u/.ssh/config']) {
      expect(isSecretFile(p)).toBe(true);
    }
  });
  it('passes ordinary report/data files', () => {
    for (const p of ['/r/report.csv', '/r/accounts-by-postiz.csv', '/r/data.json', '/r/notes.txt']) {
      expect(isSecretFile(p)).toBe(false);
    }
  });
});

describe('isInlineSafe', () => {
  it('inlines text/data/preview types, downloads active content', () => {
    expect(isInlineSafe('/r/a.csv')).toBe(true);
    expect(isInlineSafe('/r/a.pdf')).toBe(true);
    expect(isInlineSafe('/r/a.png')).toBe(true);
    expect(isInlineSafe('/r/a.html')).toBe(false);
    expect(isInlineSafe('/r/a.svg')).toBe(false);
    expect(isInlineSafe('/r/a.js')).toBe(false);
  });
});

describe('resolveServedFile (authorization)', () => {
  let root = '';
  let outside = '';
  beforeAll(() => {
    // realpath the temp roots so containment survives macOS /var → /private/var symlinks.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-out-')));
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'reports', 'accounts.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(outside, 'private.txt'), 'nope\n');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('serves a real file inside an allowed root', () => {
    const r = resolveServedFile(path.join(root, 'reports', 'accounts.csv'), [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileName).toBe('accounts.csv');
  });

  it('strips an agent file:line(:col) suffix', () => {
    const r = resolveServedFile(path.join(root, 'reports', 'accounts.csv') + ':12:3', [root]);
    expect(r.ok).toBe(true);
  });

  it('rejects blank and relative paths (400)', () => {
    expect(resolveServedFile('', [root])).toMatchObject({ ok: false, status: 400 });
    expect(resolveServedFile('reports/accounts.csv', [root])).toMatchObject({ ok: false, status: 400 });
  });

  it('404s a non-existent file', () => {
    expect(resolveServedFile(path.join(root, 'nope.csv'), [root])).toMatchObject({ ok: false, status: 404 });
  });

  it('rejects a directory (400)', () => {
    expect(resolveServedFile(path.join(root, 'reports'), [root])).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a file outside every allowed root (403)', () => {
    expect(resolveServedFile(path.join(outside, 'private.txt'), [root])).toMatchObject({ ok: false, status: 403 });
  });

  it('defeats a .. traversal out of the root (403)', () => {
    const escape = path.join(root, 'reports', '..', '..', path.basename(outside), 'private.txt');
    expect(resolveServedFile(escape, [root])).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a secret-shaped file even inside an allowed root (403)', () => {
    expect(resolveServedFile(path.join(root, '.env'), [root])).toMatchObject({ ok: false, status: 403 });
  });
});
