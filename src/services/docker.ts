/**
 * Docker readiness + lifecycle for the chat UI.
 *
 * Work mode's file tools run on the host (no Docker), but `run_command` and the
 * whole Safe-work sandbox need a running daemon. This service backs the chat
 * composer's Docker gate: a cached status probe plus best-effort "start" and
 * "install" actions the user can trigger from the Install/Start button.
 *
 * It never blocks: the action endpoints kick the work off in the background and
 * flip the cached state to `starting`/`installing`, which the composer polls
 * via GET /api/docker/status until it settles on `ready` (or back to
 * `stopped`/`missing` if it didn't take).
 *
 * Mirrors the onboarding probe in onboardingEnv.ts, but that one is a one-shot
 * welcome-screen state machine; this is the live, re-pollable runtime service.
 */

import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DockerState =
  | 'ready' // daemon reachable (`docker info` ok)
  | 'stopped' // binary present, daemon down
  | 'missing' // binary not installed
  | 'starting' // we're launching the daemon
  | 'installing'; // we're installing the engine

/** Human-readable footprint shown on the Install button. */
export const DOCKER_SIZE_HINT = '~600 MB download · ~4 GB on disk';

const PROBE_TIMEOUT = 8_000;
const CACHE_MS = 4_000;
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL = 2_000;
const INSTALL_TIMEOUT = 600_000;

let cached: DockerState = 'missing';
let cachedAt = 0;
let probeInFlight: Promise<DockerState> | null = null;
/** Single-flight for start/install — only one host action runs at a time. */
let actionInFlight: Promise<DockerState> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Daemon reachable (`docker info` exits 0). */
async function reachable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/** Docker CLI present on PATH (daemon may be down). */
async function installed(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

async function probe(): Promise<DockerState> {
  if (await reachable()) return 'ready';
  if (await installed()) return 'stopped';
  return 'missing';
}

/** Re-probe and cache the settled state (ready/stopped/missing). */
async function settle(): Promise<DockerState> {
  cached = await probe();
  cachedAt = Date.now();
  return cached;
}

/**
 * Cached status. Never overrides an in-flight action (`starting`/`installing`)
 * and dedupes concurrent probes. Refreshes once the cache is stale.
 */
export async function getDockerState(): Promise<DockerState> {
  if (cached === 'starting' || cached === 'installing') return cached;
  if (Date.now() - cachedAt < CACHE_MS) return cached;
  if (!probeInFlight) {
    probeInFlight = settle().finally(() => {
      probeInFlight = null;
    });
  }
  return probeInFlight;
}

/** Best-effort daemon launch for the current platform. */
async function launchDaemon(): Promise<void> {
  const plat = osPlatform();
  try {
    if (plat === 'darwin') {
      await execFileAsync('open', ['-a', 'Docker'], { timeout: PROBE_TIMEOUT });
    } else if (plat === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', 'Docker Desktop'], { timeout: PROBE_TIMEOUT });
    }
    // Linux: starting dockerd needs sudo, which can't prompt from this web
    // context — leave it to the user. The poll below still picks it up if they
    // start it manually.
  } catch {
    /* Docker.app not found / launch failed — the poll reports the real state. */
  }
}

/** Poll until the daemon accepts connections (Docker Desktop can take 20–40s). */
async function pollReady(): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL);
    if (await reachable()) return true;
  }
  return false;
}

/**
 * Start an installed-but-idle Docker, in the background. Returns immediately
 * with `starting`; the cached state settles to `ready`/`stopped` once the poll
 * resolves. Single-flight: a concurrent call rides the same action.
 */
export function startDocker(): DockerState {
  if (!actionInFlight) {
    cached = 'starting';
    cachedAt = Date.now();
    actionInFlight = (async () => {
      await launchDaemon();
      await pollReady();
      return settle();
    })().finally(() => {
      actionInFlight = null;
    });
  }
  return cached;
}

const INSTALL_SCRIPT = path.resolve(__dirname, '../../scripts/install-docker.sh');

/**
 * Install the Docker engine (Homebrew cask on macOS, get.docker.com on Linux),
 * then start it — all in the background. Returns immediately with `installing`;
 * the cached state settles once the install + start + poll resolve.
 */
export function installDocker(): DockerState {
  if (!actionInFlight) {
    cached = 'installing';
    cachedAt = Date.now();
    actionInFlight = (async () => {
      try {
        await execFileAsync('bash', [INSTALL_SCRIPT], { timeout: INSTALL_TIMEOUT });
      } catch {
        /* Install failed (no brew, offline, declined sudo) — settle() reports
           whether anything landed; the UI keeps the Install button. */
      }
      await launchDaemon();
      await pollReady();
      return settle();
    })().finally(() => {
      actionInFlight = null;
    });
  }
  return cached;
}
