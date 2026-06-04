/**
 * Safe Mode export / apply.
 *
 * After working in the sandbox the user may want the results OUT of it:
 *   export → copy the whole sandbox workspace to a host folder (a fresh place;
 *            nothing of theirs is overwritten). Good for "give me the output".
 *   apply  → for each folder that was copied IN (see secure-ingest's
 *            .iclaw-ingest.json), copy the new/changed files back to the
 *            ORIGINAL folder. Additive + overwrite only — never deletes the
 *            user's files — and refuses secret roots. This is the explicit
 *            "apply the sandbox's changes to my real project" action.
 *
 * Both are user-initiated (button + confirm); apply is the only path that ever
 * writes to the user's real files, and only to folders they themselves chose to
 * ingest.
 */
import {
  cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';

import { validateMountRoot } from './agent/security.js';
import { log } from './log.js';

/** Workspace internals that must never be exported/applied. */
const INTERNAL = new Set(['.tools', '.iclaw-ingest.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface ExportResult {
  ok: boolean;
  /** Host path the workspace was copied to (on success). */
  path?: string;
  files?: number;
  error?: string;
}

export interface ApplyFileChange {
  /** Original-folder-relative path that was written. */
  path: string;
  kind: 'created' | 'modified';
}

export interface ApplyResult {
  ok: boolean;
  /** Original host folder the changes were applied to. */
  source?: string;
  applied?: ApplyFileChange[];
  error?: string;
}

interface IngestLogEntry {
  kind: string;
  source: string;
  ok: boolean;
  target?: string;
}

/** Bounded recursive file count. */
function countFiles(dir: string, cap = 50_000): number {
  let total = 0;
  const stack = [dir];
  while (stack.length && total < cap) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else total++;
    }
  }
  return total;
}

/** Copy the whole sandbox (minus workspace internals) to a fresh host folder. */
export function exportWorkspace(workspaceDir: string, destDir?: string): ExportResult {
  try {
    const base = destDir && destDir.trim() ? destDir : join(homedir(), 'Downloads');
    mkdirSync(base, { recursive: true });
    const target = join(base, `iclaw-sandbox-${Date.now()}`);
    cpSync(workspaceDir, target, {
      recursive: true,
      filter: (src) => {
        const rel = relative(workspaceDir, src);
        if (!rel) return true; // the root itself
        const top = rel.split(sep)[0];
        return !INTERNAL.has(top);
      },
    });
    return { ok: true, path: target, files: countFiles(target) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readIngestLog(workspaceDir: string): IngestLogEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(workspaceDir, '.iclaw-ingest.json'), 'utf-8'));
    return Array.isArray(raw?.results) ? (raw.results as IngestLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** True when two files differ by size or content (cheap size check first). */
function differs(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return true;
    return !readFileSync(a).equals(readFileSync(b));
  } catch {
    return true; // missing target / unreadable → treat as changed
  }
}

/**
 * Copy new/changed files from `sandboxRoot` back into `originalRoot`. Additive +
 * overwrite only (never deletes); skips node_modules/.git. Returns what changed.
 */
function syncBack(sandboxRoot: string, originalRoot: string): ApplyFileChange[] {
  const applied: ApplyFileChange[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const cur = rel ? join(sandboxRoot, rel) : sandboxRoot;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(childRel);
        continue;
      }
      const from = join(sandboxRoot, childRel);
      const to = join(originalRoot, childRel);
      const existed = existsSync(to);
      if (existed && !differs(from, to)) continue; // unchanged
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      applied.push({ path: childRel, kind: existed ? 'modified' : 'created' });
    }
  }
  return applied;
}

/**
 * Apply the sandbox's changes back to the original folders that were ingested.
 * Only `folder` sources have an original to write to (repo/zip/url don't). Each
 * original is re-validated (refuses secret roots) before any write.
 */
export function applyChanges(workspaceDir: string): ApplyResult[] {
  const entries = readIngestLog(workspaceDir).filter(
    (e) => e.ok && e.kind === 'folder' && e.target,
  );
  const out: ApplyResult[] = [];
  for (const e of entries) {
    try {
      // Re-validate the destination root (refuses secret-bearing roots, resolves
      // symlinks) — the same gate ingest used, now guarding the write-back.
      const originalRoot = validateMountRoot(e.source);
      const sandboxRoot = join(workspaceDir, e.target!);
      if (!existsSync(sandboxRoot)) {
        out.push({ ok: false, source: e.source, error: 'sandbox copy missing' });
        continue;
      }
      const applied = syncBack(sandboxRoot, originalRoot);
      out.push({ ok: true, source: originalRoot, applied });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('Safe-mode apply failed', { source: e.source, error });
      out.push({ ok: false, source: e.source, error });
    }
  }
  return out;
}

/** One-line summaries for the UI. */
export function describeExport(r: ExportResult): string {
  return r.ok ? `Exported ${r.files ?? '?'} files to ${r.path}` : `Export failed: ${r.error}`;
}

export function describeApply(results: ApplyResult[]): string {
  if (results.length === 0) return 'Nothing to apply — no folders were copied into this sandbox.';
  const lines: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`✗ ${r.source}: ${r.error}`);
      continue;
    }
    const n = r.applied?.length ?? 0;
    lines.push(n === 0 ? `• ${r.source}: no changes` : `• ${r.source}: applied ${n} file(s)`);
  }
  return lines.join('\n');
}
