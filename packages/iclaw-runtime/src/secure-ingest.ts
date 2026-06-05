/**
 * Safe Mode source ingest.
 *
 * Safe Mode = "I don't trust this thing. Work on a COPY in a sandbox." So before
 * the agent touches anything, the untrusted source is brought INTO the isolated
 * sandbox workspace (~/.iclaw/secure/<id>/), and the container only ever mounts
 * that workspace. The user's original files/repos are never modified — we copy,
 * clone, extract, or download into the sandbox; the originals stay put.
 *
 * Supported sources:
 *   folder → recursive copy of a local directory (secret roots refused)
 *   repo   → shallow `git clone` of a remote http(s)/git URL
 *   zip    → extract a local .zip into the workspace
 *   url    → download a single artifact into the workspace
 *
 * Each ingest lands in its own subdirectory so multiple sources don't collide,
 * and a `.iclaw-ingest.json` log is written for the report / audit trail.
 */
import { execFile } from 'node:child_process';
import {
  cpSync, mkdirSync, statSync, writeFileSync, readdirSync, existsSync, realpathSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { validateMountRoot } from './agent/security.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT = Number(process.env.ICLAW_INGEST_CLONE_TIMEOUT) || 180_000;
const DOWNLOAD_TIMEOUT = Number(process.env.ICLAW_INGEST_DOWNLOAD_TIMEOUT) || 120_000;
/** Cap the file count we report (a cheap, bounded walk — not a full inventory). */
const COUNT_CAP = 50_000;

export type IngestSource =
  | { kind: 'folder'; path: string }
  | { kind: 'repo'; url: string }
  | { kind: 'zip'; path: string }
  | { kind: 'url'; url: string };

export interface IngestResult {
  kind: IngestSource['kind'];
  /** Human description of the source (path or URL). */
  source: string;
  ok: boolean;
  /** Workspace-relative subdir the source landed in (on success). */
  target?: string;
  /** Approximate file count copied/cloned/extracted. */
  files?: number;
  /** Failure reason (on error). */
  error?: string;
}

function sourceLabel(s: IngestSource): string {
  return s.kind === 'repo' || s.kind === 'url' ? s.url : s.path;
}

/** A non-colliding subdir name inside the workspace for `base`. */
function uniqueTarget(workspaceDir: string, base: string): string {
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'source';
  let name = safe;
  let n = 1;
  while (existsSync(join(workspaceDir, name))) name = `${safe}-${n++}`;
  return name;
}

/** Bounded recursive file count — never walks more than COUNT_CAP entries. */
function countFiles(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length && total < COUNT_CAP) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else total++;
      if (total >= COUNT_CAP) break;
    }
  }
  return total;
}

/** Derive a sane subdir name from a clone/download URL. */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return last.replace(/\.git$/i, '');
  } catch {
    return 'source';
  }
}

async function ingestFolder(workspaceDir: string, path: string): Promise<IngestResult> {
  // validateMountRoot resolves symlinks AND refuses secret-bearing roots
  // (~/.ssh, .env, credentials, …) — same gate Work Mode uses for mounts.
  const real = validateMountRoot(path);
  if (!statSync(real).isDirectory()) throw new Error('not a folder');
  const target = uniqueTarget(workspaceDir, basename(real));
  const dest = join(workspaceDir, target);
  // Copy a COPY — the original is never touched. Skip the VCS/dep noise that
  // bloats the sandbox without adding signal.
  cpSync(real, dest, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(src.slice(real.length)),
  });
  return { kind: 'folder', source: path, ok: true, target, files: countFiles(dest) };
}

async function ingestRepo(workspaceDir: string, url: string): Promise<IngestResult> {
  if (!/^(https?|git):\/\//i.test(url)) {
    throw new Error('only http(s):// or git:// repo URLs are allowed');
  }
  const target = uniqueTarget(workspaceDir, nameFromUrl(url));
  const dest = join(workspaceDir, target);
  // --depth 1, no checkout of submodules — we want a working copy, fast. git
  // clone does not execute repo code, so cloning untrusted repos on the host is
  // safe; the agent only ever RUNS the code later inside the sandbox.
  await execFileAsync('git', ['clone', '--depth', '1', '--', url, dest], { timeout: CLONE_TIMEOUT });
  return { kind: 'repo', source: url, ok: true, target, files: countFiles(dest) };
}

async function ingestZip(workspaceDir: string, path: string): Promise<IngestResult> {
  const real = realpathSync(path);
  if (!statSync(real).isFile()) throw new Error('not a file');
  const target = uniqueTarget(workspaceDir, basename(real).replace(/\.zip$/i, ''));
  const dest = join(workspaceDir, target);
  mkdirSync(dest, { recursive: true });
  // `unzip` is present on macOS and most Linux; surfaces a clear error if not.
  await execFileAsync('unzip', ['-q', '-o', real, '-d', dest], { timeout: DOWNLOAD_TIMEOUT });
  return { kind: 'zip', source: path, ok: true, target, files: countFiles(dest) };
}

async function ingestUrl(workspaceDir: string, url: string): Promise<IngestResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s):// URLs are allowed');
  const dir = join(workspaceDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  const file = uniqueTarget(dir, nameFromUrl(url) || 'download');
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(dir, file), buf);
  return { kind: 'url', source: url, ok: true, target: `downloads/${file}`, files: 1 };
}

async function ingestOne(workspaceDir: string, s: IngestSource): Promise<IngestResult> {
  switch (s.kind) {
    case 'folder': return ingestFolder(workspaceDir, s.path);
    case 'repo': return ingestRepo(workspaceDir, s.url);
    case 'zip': return ingestZip(workspaceDir, s.path);
    case 'url': return ingestUrl(workspaceDir, s.url);
  }
}

/**
 * Ingest every source into the sandbox workspace, never throwing — a failed
 * source becomes a `{ ok: false, error }` result so the others still land. Writes
 * a `.iclaw-ingest.json` log into the workspace for the report / audit trail.
 */
export async function ingestSources(
  workspaceDir: string,
  sources: IngestSource[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const s of sources) {
    try {
      results.push(await ingestOne(workspaceDir, s));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('Safe-mode ingest failed', { source: sourceLabel(s), error });
      results.push({ kind: s.kind, source: sourceLabel(s), ok: false, error });
    }
  }
  try {
    writeFileSync(
      join(workspaceDir, '.iclaw-ingest.json'),
      JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
      'utf-8',
    );
  } catch {
    /* best-effort log */
  }
  return results;
}

/** One-line user-facing summary of an ingest pass (prepended to the turn). */
export function describeIngest(results: IngestResult[]): string {
  if (results.length === 0) return '';
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = ['[Safe sandbox] Working on a COPY — your original files are unchanged.'];
  for (const r of ok) {
    lines.push(`  • copied ${r.source} → /workspace/${r.target} (${r.files ?? '?'} files)`);
  }
  for (const r of failed) {
    lines.push(`  • could not ingest ${r.source}: ${r.error}`);
  }
  return lines.join('\n');
}
