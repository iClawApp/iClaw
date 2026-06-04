import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingestSources, describeIngest } from '../../packages/iclaw-runtime/src/secure-ingest';

let root: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iclaw-ingest-test-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  // noise that should be skipped
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'big.js'), 'junk');
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: x');
  return dir;
}

describe('ingestSources — folder', () => {
  it('copies a folder into the workspace and leaves the original untouched', async () => {
    const src = makeProject('my-app');
    const results = await ingestSources(workspace, [{ kind: 'folder', path: src }]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'folder', ok: true, target: 'my-app' });

    // Copy landed in the sandbox.
    const copied = join(workspace, 'my-app');
    expect(readFileSync(join(copied, 'src', 'index.ts'), 'utf-8')).toContain('export const x');
    expect(existsSync(join(copied, 'README.md'))).toBe(true);

    // Original is byte-for-byte intact (Safe Mode never touches it).
    expect(readFileSync(join(src, 'src', 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(existsSync(join(src, 'node_modules', 'pkg', 'big.js'))).toBe(true);
  });

  it('skips node_modules and .git when copying', async () => {
    const src = makeProject('app2');
    await ingestSources(workspace, [{ kind: 'folder', path: src }]);
    const copied = join(workspace, 'app2');
    expect(existsSync(join(copied, 'node_modules'))).toBe(false);
    expect(existsSync(join(copied, '.git'))).toBe(false);
    // file count reflects only the real source files (index.ts + README.md).
    const log = JSON.parse(readFileSync(join(workspace, '.iclaw-ingest.json'), 'utf-8'));
    expect(log.results[0].files).toBe(2);
  });

  it('gives colliding basenames distinct targets', async () => {
    const a = join(root, 'a', 'project');
    const b = join(root, 'b', 'project');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'f.txt'), 'A');
    writeFileSync(join(b, 'f.txt'), 'B');
    const results = await ingestSources(workspace, [
      { kind: 'folder', path: a },
      { kind: 'folder', path: b },
    ]);
    expect(results[0].target).toBe('project');
    expect(results[1].target).toBe('project-1');
    expect(readFileSync(join(workspace, 'project', 'f.txt'), 'utf-8')).toBe('A');
    expect(readFileSync(join(workspace, 'project-1', 'f.txt'), 'utf-8')).toBe('B');
  });

  it('refuses a secret-bearing folder root (e.g. .ssh) without throwing', async () => {
    const secret = join(root, '.ssh');
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, 'id_rsa'), 'PRIVATE');
    const results = await ingestSources(workspace, [{ kind: 'folder', path: secret }]);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBeTruthy();
    // Nothing leaked into the sandbox.
    expect(existsSync(join(workspace, '.ssh'))).toBe(false);
  });

  it('reports a missing folder as a failed (not thrown) result', async () => {
    const results = await ingestSources(workspace, [
      { kind: 'folder', path: join(root, 'does-not-exist') },
    ]);
    expect(results[0].ok).toBe(false);
  });
});

describe('describeIngest', () => {
  it('summarizes copies and reassures about originals', () => {
    const text = describeIngest([
      { kind: 'folder', source: '/home/me/app', ok: true, target: 'app', files: 12 },
    ]);
    expect(text).toContain('original files are unchanged');
    expect(text).toContain('/workspace/app');
  });

  it('returns empty for no sources', () => {
    expect(describeIngest([])).toBe('');
  });
});
