import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportWorkspace } from '../../packages/iclaw-runtime/src/secure-export';

let root: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iclaw-export-test-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('exportWorkspace', () => {
  it('copies the sandbox out, excluding workspace internals', () => {
    writeFileSync(join(workspace, 'result.txt'), 'output');
    mkdirSync(join(workspace, '.tools'), { recursive: true });
    writeFileSync(join(workspace, '.tools', 'bin'), 'junk');
    writeFileSync(join(workspace, '.iclaw-ingest.json'), '{}');

    const dest = join(root, 'out');
    const r = exportWorkspace(workspace, dest);
    expect(r.ok).toBe(true);
    expect(r.path!.startsWith(dest)).toBe(true);
    expect(readFileSync(join(r.path!, 'result.txt'), 'utf-8')).toBe('output');
    // Internals are not exported.
    expect(existsSync(join(r.path!, '.tools'))).toBe(false);
    expect(existsSync(join(r.path!, '.iclaw-ingest.json'))).toBe(false);
  });
});
