/**
 * Safe Mode export.
 *
 * After working in the sandbox the user may want the results OUT of it: export
 * copies the whole sandbox workspace to a fresh host folder (nothing of theirs is
 * overwritten). Good for "give me the output". User-initiated (button + confirm);
 * it only ever reads the sandbox and writes to a new folder, never to originals.
 */
import {
  cpSync, mkdirSync, existsSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** Workspace internals that must never be exported. */
const INTERNAL = new Set(['.tools', '.iclaw-ingest.json']);

export interface ExportResult {
  ok: boolean;
  /** Host path the workspace was copied to (on success). */
  path?: string;
  files?: number;
  error?: string;
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

/**
 * Local date-time slug like "2026-06-09_14-30-15" for naming exported folders,
 * so a non-technical user can tell exports apart at a glance instead of reading
 * an opaque epoch number.
 */
function exportStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * First folder name under `base` that doesn't already exist: starts from `name`,
 * then appends "-2", "-3", … if the user exported more than once in the same
 * second. Epoch fallback if (somehow) all are taken.
 */
function uniqueDir(base: string, name: string): string {
  if (!existsSync(join(base, name))) return join(base, name);
  for (let i = 2; i < 1000; i++) {
    const candidate = join(base, `${name}-${i}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(base, `${name}-${Date.now()}`);
}

/** Copy the whole sandbox (minus workspace internals) to a fresh host folder. */
export function exportWorkspace(workspaceDir: string, destDir?: string): ExportResult {
  try {
    const base = destDir && destDir.trim() ? destDir : join(homedir(), 'Downloads');
    mkdirSync(base, { recursive: true });
    const target = uniqueDir(base, `iclaw-sandbox-${exportStamp()}`);
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

/** One-line summary for the UI. */
export function describeExport(r: ExportResult): string {
  return r.ok ? `Exported ${r.files ?? '?'} files to ${r.path}` : `Export failed: ${r.error}`;
}
