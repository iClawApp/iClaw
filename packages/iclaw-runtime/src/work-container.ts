/**
 * Work Mode command sandbox.
 *
 * Work Mode = "I trust this folder. Work on the REAL files, but only inside it."
 * The agent loop and the file tools (read/write/list/search) run on the host —
 * they're path-checked (validatePath) and gated by per-write approval. The one
 * tool that can't be safely contained on the host is `run_command`: arbitrary
 * `bash -c` can write/delete anywhere, ignoring our per-folder flags.
 *
 * So `run_command` is routed into a Docker container. Each allowed folder is
 * bind-mounted to a NORMALIZED container path — `/work/0`, `/work/1`, … — with
 * `:ro` or `:rw` per its access level. This scheme is identical on macOS, Linux
 * and Windows (no same-path mounts, which can't work on Windows where the host
 * path is `C:\…`). The kernel enforces the flags: a write into a `:ro` mount
 * fails with "Read-only file system", and anything outside the mounts is simply
 * invisible — the command literally cannot see the rest of the computer.
 *
 * The model speaks in HOST paths (the file tools and the folder list it sees use
 * them), so run_command's host `cwd` and any host folder roots in the command
 * are translated to their `/work/<n>` equivalents before exec — see
 * hostToContainer / translateCommandPaths.
 *
 * After each command we scan the writable mounts and report which files were
 * created / modified / deleted, reassuring the user that all changes stayed
 * inside the allowed folders.
 *
 * When Docker is unavailable, `run_command` is disabled (strict fallback) — the
 * host file tools still work, so read-only stays an honest guarantee.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { log } from './log.js';

const execFileAsync = promisify(execFile);

const WORK_PREFIX = 'iclaw-work-';
const COMMAND_TIMEOUT = Number(process.env.ICLAW_WORK_COMMAND_TIMEOUT) || 60_000;
// `docker run` auto-pulls the image on first use; allow time for that.
const START_TIMEOUT = Number(process.env.ICLAW_WORK_START_TIMEOUT) || 300_000;
/** Cap the per-command file scan so a huge tree can't stall the turn. */
const SCAN_MAX_FILES = Number(process.env.ICLAW_WORK_SCAN_MAX_FILES) || 20_000;
/** Cap how many changed paths we list back (the rest collapse to "+N more"). */
const SCAN_MAX_REPORT = 50;

// The shared iClaw sandbox image — ONE image for both Safe work and Work mode
// (container/secure-sandbox.Dockerfile, 80/20 toolset). Resolved lazily.
const SANDBOX_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
// Last-resort fallback when the shared image hasn't been built yet: a public
// base that already ships bash, git and node, so Work still runs (with a leaner
// toolset) on a fresh checkout. Auto-pulled by `docker run`.
const FALLBACK_IMAGE = process.env.ICLAW_WORK_SLIM_IMAGE || 'node:22';

/**
 * One allowed folder, mapped from its host path to a normalized container path.
 * `label` (the folder's basename) is only used to make reports readable.
 */
export interface WorkMount {
  /** Validated absolute host path (the source of the bind mount). */
  path: string;
  /** Normalized in-container mount point: `/work/<n>`. */
  containerPath: string;
  /** Read-only (`:ro`) when true, read & write (`:rw`) otherwise. */
  readonly: boolean;
  /** Folder basename, for human-readable change reports. */
  label: string;
}

/** Folder basename for a host path (handles both separators). */
function basenameOf(hostPath: string): string {
  const parts = hostPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || hostPath;
}

/**
 * Assign normalized `/work/<n>` container paths to validated allowed folders.
 * Order is stable (index = position), so the same folder set always maps the
 * same way within a session.
 */
export function toWorkMounts(folders: { path: string; readonly: boolean }[]): WorkMount[] {
  return folders.map((f, i) => ({
    path: f.path,
    containerPath: `/work/${i}`,
    readonly: f.readonly,
    label: basenameOf(f.path),
  }));
}

/** Path key for prefix comparison: forward slashes; lowercased on Windows. */
function normKey(p: string, plat: NodeJS.Platform): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return plat === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Map a host path (cwd or any path under an allowed folder) to its container
 * path. Returns null when the path isn't inside any mount — the caller then
 * refuses, so a command can never `cd` outside the allowed folders.
 */
export function hostToContainer(
  hostPath: string,
  mounts: WorkMount[],
  plat: NodeJS.Platform = process.platform,
): string | null {
  const target = normKey(hostPath, plat);
  // Longest root first so a nested mount wins over its parent.
  const sorted = [...mounts].sort((a, b) => b.path.length - a.path.length);
  for (const m of sorted) {
    const root = normKey(m.path, plat);
    if (target === root) return m.containerPath;
    if (target.startsWith(root + '/')) {
      return m.containerPath + target.slice(root.length);
    }
  }
  return null;
}

/** Map a container path (`/work/<n>/…`) back to its host path, for reports. */
export function containerToHost(containerPath: string, mounts: WorkMount[]): string {
  for (const m of mounts) {
    if (containerPath === m.containerPath) return m.path;
    if (containerPath.startsWith(m.containerPath + '/')) {
      const rel = containerPath.slice(m.containerPath.length + 1);
      const sep = m.path.includes('\\') ? '\\' : '/';
      return m.path.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep);
    }
  }
  return containerPath;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite host folder roots inside a shell command to their container paths.
 *
 * The model emits host paths (that's all it sees), so a command may reference
 * `~/Projects/app/...` or `C:\Users\me\app\...`. We replace each allowed-folder
 * root (in both native and forward-slash form) with its `/work/<n>` mount and
 * normalize the tail to forward slashes, stopping at whitespace, quotes, and
 * shell metacharacters so a path can't swallow the rest of the command. The
 * structured `cwd` is mapped separately (hostToContainer); this catches inline
 * absolute paths in the command body.
 */
export function translateCommandPaths(
  command: string,
  mounts: WorkMount[],
  plat: NodeJS.Platform = process.platform,
): string {
  let out = command;
  const flags = plat === 'win32' ? 'gi' : 'g';
  // Tail must start with a separator (or be empty) so the root only matches at a
  // path boundary — `/a` must not match inside `/abc`. The lookahead then
  // asserts the token really ends (whitespace, quote, shell metachar, or EOL).
  const TAIL = "((?:[/\\\\][^\\s\"'`&|;<>()]*)?)";
  const BOUND = "(?=[\\s\"'`&|;<>()]|$)";
  // Longest root first so a nested mount wins over its parent.
  const sorted = [...mounts].sort((a, b) => b.path.length - a.path.length);
  for (const m of sorted) {
    for (const variant of new Set([m.path, m.path.replace(/\\/g, '/')])) {
      const esc = escapeRegex(variant);
      out = out.replace(
        new RegExp(esc + TAIL + BOUND, flags),
        (_full, tail: string) => m.containerPath + (tail || '').replace(/\\/g, '/'),
      );
    }
  }
  return out;
}

let dockerOk: boolean | null = null;
let resolvedImage: string | null = null;

/** True if a usable Docker daemon is reachable. Cached after the first probe. */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerOk !== null) return dockerOk;
  try {
    await execFileAsync('docker', ['info'], { timeout: 8_000 });
    dockerOk = true;
  } catch {
    dockerOk = false;
  }
  return dockerOk;
}

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the image for Work Mode commands. Order:
 *   1. ICLAW_WORK_IMAGE — explicit override (e.g. a heavier python/go toolchain).
 *   2. The shared sandbox image (iclaw-secure:latest) — the canonical choice,
 *      identical to what Safe work uses, so one build serves both modes.
 *   3. Fallback public base (node:22) only when the shared image isn't built —
 *      logged as a warning so the leaner toolset isn't a silent surprise.
 * Cached after the first resolve.
 */
export async function resolveWorkImage(): Promise<string> {
  if (resolvedImage) return resolvedImage;
  if (process.env.ICLAW_WORK_IMAGE) {
    resolvedImage = process.env.ICLAW_WORK_IMAGE;
  } else if (await imageExists(SANDBOX_IMAGE)) {
    resolvedImage = SANDBOX_IMAGE;
  } else {
    log.warn(
      'Shared sandbox image not built — Work Mode falling back to a leaner base. ' +
        'Build it with `npm run build:secure-image` for the full toolset.',
      { fallback: FALLBACK_IMAGE, sandbox: SANDBOX_IMAGE },
    );
    resolvedImage = FALLBACK_IMAGE;
  }
  return resolvedImage;
}

/**
 * Start a long-lived Work container with the given folder mounts. Returns the
 * container name. Fail-closed: throws if Docker can't start it, so the caller
 * keeps run_command disabled instead of silently running unsandboxed.
 */
export async function startWorkContainer(mounts: WorkMount[], image: string): Promise<string> {
  const name = `${WORK_PREFIX}${randomUUID().slice(0, 8)}`;
  const mountArgs: string[] = [];
  for (const m of mounts) {
    // Source = native host path (the Docker CLI handles the `X:\` drive prefix
    // on Windows); target = normalized `/work/<n>` mount point.
    mountArgs.push('-v', `${m.path}:${m.containerPath}:${m.readonly ? 'ro' : 'rw'}`);
  }
  // Default working dir: first writable folder, else the first mount.
  const home = mounts.find((m) => !m.readonly) ?? mounts[0];

  try {
    await execFileAsync('docker', [
      'run', '--rm', '-d',
      '--name', name,
      '--memory', process.env.ICLAW_WORK_MEMORY || '768m',
      '--cpus', process.env.ICLAW_WORK_CPUS || '1',
      ...mountArgs,
      ...(home ? ['--workdir', home.containerPath] : []),
      image,
      'sleep', '86400',
    ], { timeout: START_TIMEOUT });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `Work sandbox failed to start — is Docker running? ${(e.stderr || e.message || '').slice(0, 200)}`,
    );
  }
  return name;
}

export interface ExecOptions {
  /** Folder mappings — used to translate the host cwd + command paths. */
  mounts?: WorkMount[];
  /** Run a post-command change scan and append a report (Work run_command). */
  scan?: boolean;
}

/**
 * Execute a command inside a Work container at the given HOST cwd. The cwd and
 * any host folder roots in the command are translated to their `/work/<n>`
 * container paths first; a cwd outside every mount is refused (the command can
 * never operate outside the allowed folders). With `scan`, a before/after diff
 * of the writable mounts is appended so the user sees exactly what changed.
 */
export async function execInWorkContainer(
  name: string,
  command: string,
  hostCwd: string,
  opts: ExecOptions = {},
): Promise<string> {
  const mounts = opts.mounts ?? [];
  // Translate the host cwd → container path. '/' (linkSandbox) and already-
  // container paths fall through unchanged.
  let containerCwd = hostCwd;
  if (mounts.length) {
    const mapped = hostToContainer(hostCwd, mounts);
    if (mapped) {
      containerCwd = mapped;
    } else if (!hostCwd.startsWith('/work/') && hostCwd !== '/') {
      return `Refused: working directory "${hostCwd}" is outside the folders you allowed for this chat.`;
    }
  }
  const containerCmd = translateCommandPaths(command, mounts);

  const before = opts.scan ? await snapshotWritable(name, mounts) : null;
  const output = await rawExec(name, containerCmd, containerCwd);
  if (!before) return output;

  const after = await snapshotWritable(name, mounts);
  const report = renderChangeReport(before, after, mounts);
  return report ? `${output}\n\n${report}` : output;
}

/** Bare `docker exec` — returns combined stdout/stderr (or the error text). */
async function rawExec(name: string, command: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker', ['exec', '--workdir', cwd, name, 'bash', '-lc', command],
      { timeout: COMMAND_TIMEOUT },
    );
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim() || 'Error';
  }
}

type FileSnapshot = Map<string, string>; // container path → mtime (epoch float)

/**
 * Snapshot files in the WRITABLE mounts (read-only mounts can't change, so we
 * skip them). Excludes .git / node_modules churn so the report stays meaningful.
 * Best-effort: returns an empty snapshot if `find` fails or the tree is huge.
 */
async function snapshotWritable(name: string, mounts: WorkMount[]): Promise<FileSnapshot> {
  const snap: FileSnapshot = new Map();
  const writable = mounts.filter((m) => !m.readonly);
  if (writable.length === 0) return snap;
  const roots = writable.map((m) => m.containerPath);
  // GNU find (the container is always Linux): print "<mtime>\t<path>" per file.
  const findCmd =
    `find ${roots.map((r) => `'${r}'`).join(' ')} -type f ` +
    `-not -path '*/.git/*' -not -path '*/node_modules/*' ` +
    `-printf '%T@\\t%p\\n' 2>/dev/null | head -n ${SCAN_MAX_FILES}`;
  try {
    const { stdout } = await execFileAsync(
      'docker', ['exec', name, 'bash', '-lc', findCmd],
      { timeout: COMMAND_TIMEOUT },
    );
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      snap.set(line.slice(tab + 1), line.slice(0, tab));
    }
  } catch {
    /* best-effort — an empty/partial snapshot just yields a sparser report. */
  }
  return snap;
}

interface ChangeSet {
  created: string[];
  modified: string[];
  deleted: string[];
}

function diffSnapshots(before: FileSnapshot, after: FileSnapshot): ChangeSet {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, mtime] of after) {
    const prev = before.get(p);
    if (prev === undefined) created.push(p);
    else if (prev !== mtime) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { created, modified, deleted };
}

/** Human-readable change block appended to run_command output (host paths). */
function renderChangeReport(
  before: FileSnapshot,
  after: FileSnapshot,
  mounts: WorkMount[],
): string {
  const { created, modified, deleted } = diffSnapshots(before, after);
  const total = created.length + modified.length + deleted.length;
  const lines: string[] = ['── File changes (Work sandbox) ──'];
  if (total === 0) {
    lines.push('No files were created, modified, or deleted.');
    return lines.join('\n');
  }
  const section = (mark: string, label: string, paths: string[]): void => {
    if (paths.length === 0) return;
    const shown = paths.slice(0, SCAN_MAX_REPORT);
    for (const p of shown) lines.push(`${mark} ${label}: ${containerToHost(p, mounts)}`);
    if (paths.length > shown.length) {
      lines.push(`  …and ${paths.length - shown.length} more ${label} file(s)`);
    }
  };
  section('+', 'created', created);
  section('~', 'modified', modified);
  section('-', 'deleted', deleted);
  // By construction the shell only sees mounted folders, so every change above
  // is inside an allowed folder — state it plainly for reassurance.
  lines.push('All changes were inside the folders you allowed.');
  return lines.join('\n');
}

/** Kill Work containers orphaned by a previous runtime process. */
export async function killOrphanWorkContainers(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'docker', ['ps', '-aq', '--filter', `name=${WORK_PREFIX}`],
      { timeout: 10_000 },
    );
    const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    await execFileAsync('docker', ['rm', '-f', ...ids], { timeout: 30_000 }).catch(() => {});
    return ids.length;
  } catch {
    return 0;
  }
}
