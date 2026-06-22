/**
 * Authorize + resolve an agent-written local file for serving over `/workspace-file`.
 *
 * Agent replies link files by raw absolute local path — a CSV report the OpenClaw
 * gateway wrote to its workspace, or a script in a granted Work folder. The browser
 * can't open `/Users/…` (it GETs it from our server → "Cannot GET"), so the user had
 * to hunt for the file in Finder. This maps such a path to a download/preview, but
 * ONLY when it lives under a root the agent already had access to — never an
 * arbitrary host file. Tightly scoped: realpath (defeats `..`/symlink escape) +
 * containment in an allowlisted root + a secret-file deny-list.
 *
 * The core (`resolveServedFile`) is a pure function over an explicit `roots` list so
 * the path-traversal / deny-list logic is unit-testable without HTTP or the KV store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { kvGetByPrefix } from '../db/kv';

// Mirror of packages/iclaw-runtime/src/agent/security.ts — we can't import across the
// src↔runtime rootDir boundary (the runtime runs as a sidecar), so the deny-list is
// duplicated here. Keep the two in sync: a file the runtime refuses to read must also
// never be served. Conservative by design (a stray "tokens.json" is refused).
const BLOCKED_PATTERNS = [
  '.env', '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
  'id_rsa', 'id_ed25519', 'id_dsa', 'private_key',
  '.netrc', '.npmrc', '.pypirc', '.secret',
];
const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.cert', '.crt'];
const BLOCKED_NAMES = ['credentials', 'secrets', 'token', 'tokens'];

/** True if a real path looks like a secret/credential file (any component, extension,
 *  or basename). Mirrors the runtime's findBlockedPattern. */
export function isSecretFile(realPath: string): boolean {
  for (const part of realPath.split(path.sep)) {
    for (const b of BLOCKED_PATTERNS) if (part === b || part.startsWith(b + '.')) return true;
  }
  if (BLOCKED_EXTENSIONS.includes(path.extname(realPath).toLowerCase())) return true;
  const base = path.basename(realPath).toLowerCase();
  for (const b of BLOCKED_NAMES) if (base === b || base.startsWith(b + '.')) return true;
  return false;
}

/** OpenClaw workspace root — where gateway chats write reports/artifacts. */
export function openClawWorkspaceRoot(): string {
  return process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
}

/** Resolve a path to its realpath, falling back to a plain resolve if it doesn't
 *  exist yet (so a configured-but-absent root still contributes a stable prefix). */
function realOrResolve(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Every root the agent could already reach: the OpenClaw workspace + every Work
 * folder the user granted (across all projects), read from the UI KV store the
 * browser persists folders in (`ui.iclaw:work-folders:project:<id>` / `:no-project`,
 * value = JSON `[{path,write}|string]`). Serving these discloses nothing the agent
 * couldn't already read.
 */
export function resolveAllowedRoots(): string[] {
  const roots = new Set<string>();
  roots.add(realOrResolve(openClawWorkspaceRoot()));
  try {
    for (const v of Object.values(kvGetByPrefix('ui.iclaw:work-folders:'))) {
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const f of parsed) {
        const p = typeof f === 'string'
          ? f
          : f && typeof f === 'object' ? (f as { path?: unknown }).path : undefined;
        if (typeof p === 'string' && p) roots.add(realOrResolve(p));
      }
    }
  } catch {
    // KV not ready / store error → workspace-only is a safe fallback.
  }
  return [...roots];
}

/** True if `child` is `root` or sits inside it (both already resolved). */
export function isWithin(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export type ServeResolution =
  | { ok: true; realPath: string; fileName: string }
  | { ok: false; status: number; reason: string };

/**
 * Authorize a requested path against `roots`. Pure except for fs.realpath/stat (pass
 * `roots` in tests). Normalises a `file://` scheme, strips an agent `path:line(:col)`
 * suffix and a leading `~`. Refuses: blank/relative input, non-existent, a directory,
 * anything outside every root, or a secret-shaped file.
 */
export function resolveServedFile(rawPath: string, roots: string[]): ServeResolution {
  let p = String(rawPath ?? '').trim();
  if (!p) return { ok: false, status: 400, reason: 'No file path given.' };
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch { p = p.replace(/^file:\/\//i, ''); }
  }
  p = p.replace(/:\d+(?::\d+)?$/, ''); // drop an agent "file:line" / "file:line:col" ref
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) return { ok: false, status: 400, reason: 'File path must be absolute.' };

  let real: string;
  try { real = fs.realpathSync(p); } catch { return { ok: false, status: 404, reason: 'File not found.' }; }

  let stat: fs.Stats;
  try { stat = fs.statSync(real); } catch { return { ok: false, status: 404, reason: 'File not found.' }; }
  if (stat.isDirectory()) return { ok: false, status: 400, reason: 'That path is a folder, not a file.' };

  if (!roots.some((r) => isWithin(r, real))) {
    return {
      ok: false,
      status: 403,
      reason: 'This file is outside the folders iClaw can serve (the OpenClaw workspace or a folder you granted to Work Mode).',
    };
  }
  if (isSecretFile(real)) {
    return { ok: false, status: 403, reason: 'This looks like a secret/credential file and is not served.' };
  }
  return { ok: true, realPath: real, fileName: path.basename(real) };
}

/** Extensions safe to render INLINE in the app's own origin. Everything else is
 *  forced to download — never inline-serve active content (html/svg/js) same-origin. */
const INLINE_SAFE_EXT = new Set([
  '.txt', '.csv', '.tsv', '.log', '.md', '.json', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
]);
export function isInlineSafe(realPath: string): boolean {
  return INLINE_SAFE_EXT.has(path.extname(realPath).toLowerCase());
}
