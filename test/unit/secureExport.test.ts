import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingestSources } from '../../packages/iclaw-runtime/src/secure-ingest';
import {
  exportWorkspace, applyChanges,
} from '../../packages/iclaw-runtime/src/secure-export';

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

describe('applyChanges', () => {
  it('copies new and modified files back to the original, without deleting', async () => {
    // Original project.
    const src = join(root, 'project');
    mkdirSync(join(src, 'src'), { recursive: true });
    writeFileSync(join(src, 'src', 'a.ts'), 'A\n');
    writeFileSync(join(src, 'keep.txt'), 'KEEP\n');

    // Ingest it (records the source→target mapping in .iclaw-ingest.json).
    await ingestSources(workspace, [{ kind: 'folder', path: src }]);
    const sandbox = join(workspace, 'project');

    // Agent edits a.ts, adds b.ts, and "deletes" keep.txt inside the sandbox.
    writeFileSync(join(sandbox, 'src', 'a.ts'), 'A changed\n');
    writeFileSync(join(sandbox, 'new.ts'), 'NEW\n');
    rmSync(join(sandbox, 'keep.txt'), { force: true });

    const results = applyChanges(workspace);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    const applied = results[0].applied!.map((c) => `${c.kind}:${c.path}`).sort();

    // Modified + created are applied back to the original.
    expect(readFileSync(join(src, 'src', 'a.ts'), 'utf-8')).toBe('A changed\n');
    expect(readFileSync(join(src, 'new.ts'), 'utf-8')).toBe('NEW\n');
    expect(applied.some((s) => s.includes('a.ts'))).toBe(true);
    expect(applied.some((s) => s.includes('new.ts'))).toBe(true);

    // Deletion in the sandbox does NOT delete the user's original file.
    expect(existsSync(join(src, 'keep.txt'))).toBe(true);
    expect(readFileSync(join(src, 'keep.txt'), 'utf-8')).toBe('KEEP\n');
  });

  it('applies nothing when the sandbox is unchanged', async () => {
    const src = join(root, 'p2');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'f.txt'), 'same\n');
    await ingestSources(workspace, [{ kind: 'folder', path: src }]);

    const results = applyChanges(workspace);
    expect(results[0].ok).toBe(true);
    expect(results[0].applied).toEqual([]);
  });

  it('returns empty when nothing was ingested', () => {
    expect(applyChanges(workspace)).toEqual([]);
  });
});
