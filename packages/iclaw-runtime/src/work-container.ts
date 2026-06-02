/**
 * Work Mode command sandbox.
 *
 * Work Mode runs its agent loop on the host and keeps file tools (read/write/
 * list/search) on the host too — they're already path-checked and write_file
 * enforces per-folder read-only. The one tool that can't be safely contained on
 * the host is `run_command`: arbitrary `bash -c` can write/delete anywhere,
 * ignoring our per-folder flags.
 *
 * So `run_command` is routed into a Docker container instead. Each allowed
 * folder is bind-mounted at its SAME absolute path with `:ro` (read-only) or
 * `:rw` (read & write) per the folder's access level. The kernel then enforces
 * read-only — any write into a `:ro` mount fails with "Read-only file system",
 * and folders we never mounted are simply invisible. Same-path mounting keeps
 * the paths the model uses identical inside and outside the container (works on
 * Linux and Docker Desktop for macOS; Windows path translation is a follow-up).
 *
 * When Docker is unavailable, `run_command` is disabled (strict fallback) —
 * file tools still work, so read-only stays an honest guarantee.
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

// Slim, zero-maintenance default: a public image that already ships bash, git
// and node. Resolved lazily — see resolveWorkImage().
const SLIM_IMAGE = process.env.ICLAW_WORK_SLIM_IMAGE || 'node:22';
const SECURE_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';

export interface WorkMount {
  path: string;
  readonly: boolean;
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
 *   1. ICLAW_WORK_IMAGE — explicit override (e.g. a python/go toolchain).
 *   2. iclaw-secure:latest if already built — zero extra download.
 *   3. Slim public default (node:22) — pulled on first run.
 * Cached after the first resolve.
 */
export async function resolveWorkImage(): Promise<string> {
  if (resolvedImage) return resolvedImage;
  if (process.env.ICLAW_WORK_IMAGE) {
    resolvedImage = process.env.ICLAW_WORK_IMAGE;
  } else if (await imageExists(SECURE_IMAGE)) {
    log.info('Work Mode reusing existing secure image for commands', { image: SECURE_IMAGE });
    resolvedImage = SECURE_IMAGE;
  } else {
    resolvedImage = SLIM_IMAGE;
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
    mountArgs.push('-v', `${m.path}:${m.path}:${m.readonly ? 'ro' : 'rw'}`);
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
      ...(home ? ['--workdir', home.path] : []),
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

/** Execute a command inside a Work container, with cwd set to a mounted path. */
export async function execInWorkContainer(name: string, command: string, cwd: string): Promise<string> {
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
