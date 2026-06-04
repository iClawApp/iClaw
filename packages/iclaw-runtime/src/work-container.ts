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
 * and folders we never mounted are simply invisible. On Linux and Docker
 * Desktop for macOS we same-path mount, so the paths the model uses are
 * identical inside and outside the container. On Windows the container is still
 * Linux, so host drive paths (`C:\Users\foo`) are translated to their container
 * equivalents (`/c/Users/foo`) for the mount target, working dir, and any host
 * roots the model references in a command — see hostToContainerPath /
 * translateCommandPaths.
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

// The shared iClaw sandbox image — ONE image for both Safe work and Work mode
// (container/secure-sandbox.Dockerfile, 80/20 toolset). Resolved lazily.
const SANDBOX_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
// Last-resort fallback when the shared image hasn't been built yet: a public
// base that already ships bash, git and node, so Work still runs (with a leaner
// toolset) on a fresh checkout. Auto-pulled by `docker run`.
const FALLBACK_IMAGE = process.env.ICLAW_WORK_SLIM_IMAGE || 'node:22';

export interface WorkMount {
  path: string;
  readonly: boolean;
}

/**
 * Translate a host absolute path to the path it is mounted at INSIDE the Linux
 * container.
 *
 * On macOS/Linux this is the identity — we same-path mount, so the paths the
 * model uses are identical inside and outside the container. On Windows the
 * container is still Linux, so a drive path like `C:\Users\foo` is not a valid
 * mount target or working dir. Docker Desktop's convention maps it to
 * `/c/Users/foo` (drive letter lowercased, backslashes → forward slashes), so
 * we mount each folder there and run commands against that path.
 *
 * The mount SOURCE stays the native host path: the Docker CLI recognises the
 * `X:\` drive prefix in `-v`, so only the target needs translating.
 */
export function hostToContainerPath(
  hostPath: string,
  plat: NodeJS.Platform = process.platform,
): string {
  if (plat !== 'win32') return hostPath;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    return `/${drive[1].toLowerCase()}/${rest}`;
  }
  // Already POSIX-ish, or a UNC path we can't map — best-effort slash normalize.
  return hostPath.replace(/\\/g, '/');
}

/**
 * Rewrite Windows drive paths inside a shell command to their container paths.
 *
 * The model only ever sees host (Windows) paths — file tools return them and
 * the allowed folders are Windows paths — so a `run_command` it emits will
 * reference `C:\Users\foo\...`. Backslash separators don't work in the Linux
 * sandbox, so every absolute drive-path token (`X:\…` or `X:/…`) is converted
 * whole to its `/x/…` container form. We stop the token at whitespace, quotes,
 * and shell metacharacters so a path can't swallow the rest of the command.
 * Identity on non-Windows.
 */
export function translateCommandPaths(
  command: string,
  plat: NodeJS.Platform = process.platform,
): string {
  if (plat !== 'win32') return command;
  return command.replace(/[A-Za-z]:[\\/][^\s"'`&|;<>()]*/g, (m) =>
    hostToContainerPath(m, plat),
  );
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
    // Source = native host path (Docker CLI handles the `X:\` drive prefix);
    // target = translated container path (same-path on macOS/Linux).
    mountArgs.push('-v', `${m.path}:${hostToContainerPath(m.path)}:${m.readonly ? 'ro' : 'rw'}`);
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
      ...(home ? ['--workdir', hostToContainerPath(home.path)] : []),
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

/**
 * Execute a command inside a Work container, with cwd set to a mounted path.
 * On Windows the cwd and any host drive paths in the command are translated to
 * their container equivalents; a no-op on macOS/Linux (same-path mounting).
 */
export async function execInWorkContainer(
  name: string,
  command: string,
  cwd: string,
): Promise<string> {
  const containerCwd = hostToContainerPath(cwd);
  const containerCmd = translateCommandPaths(command);
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker', ['exec', '--workdir', containerCwd, name, 'bash', '-lc', containerCmd],
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
