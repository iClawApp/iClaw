/**
 * On-demand Docker lifecycle.
 *
 * Docker is only needed when a task actually runs a sandboxed command (Work
 * run_command / analyze_link, or any Safe-Mode turn). So instead of nagging the
 * user up front, we start Docker ourselves the first moment a task needs it, and
 * — only if WE started it — stop it again once it's been idle and there are no
 * containers left running (so we never kill the user's own Docker work).
 *
 *   ensureDockerForTask() → true if Docker is usable now (started it if needed)
 *   startDockerIdleReaper() → background loop that stops a self-started, idle,
 *                             container-free daemon after ICLAW_DOCKER_IDLE_STOP_MS
 *
 * Linux is start-only-by-the-user (the daemon needs sudo), so there we never
 * auto-start or auto-stop.
 */
import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { promisify } from 'node:util';

import { log } from './log.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT = 8_000;
const START_POLL_ATTEMPTS = 30;
const START_POLL_INTERVAL = 2_000;
/** Idle window before stopping a daemon we started (default 15 min). */
const IDLE_STOP_MS = Number(process.env.ICLAW_DOCKER_IDLE_STOP_MS) || 15 * 60_000;
const REAPER_INTERVAL = 60_000;

/** True only while THIS process is responsible for the running daemon. */
let weStartedDocker = false;
/** Last time a task used Docker (resets the idle-stop countdown). */
let lastDockerUse = 0;
let ensureInFlight: Promise<boolean> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function reachable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

async function installed(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

async function launchDaemon(): Promise<void> {
  const plat = osPlatform();
  if (plat === 'darwin') {
    await execFileAsync('open', ['-a', 'Docker'], { timeout: PROBE_TIMEOUT });
  } else if (plat === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', 'Docker Desktop'], { timeout: PROBE_TIMEOUT });
  }
  // Linux: starting dockerd needs sudo — leave it to the user.
}

/**
 * Ensure Docker is usable for a task RIGHT NOW. If it's down but installed, start
 * it ourselves and wait (up to ~60s). Returns false when Docker is missing or
 * couldn't be started (caller then disables run_command / fails the Safe turn).
 * Single-flight so concurrent tools don't each try to launch the daemon.
 */
export function ensureDockerForTask(): Promise<boolean> {
  if (!ensureInFlight) {
    ensureInFlight = (async () => {
      if (await reachable()) {
        lastDockerUse = Date.now();
        return true;
      }
      if (!(await installed()) || osPlatform() === 'linux') return false;
      log.info('Docker is down but a task needs it — starting it');
      try {
        await launchDaemon();
      } catch {
        return false; // Docker.app not found / launch failed
      }
      for (let i = 0; i < START_POLL_ATTEMPTS; i++) {
        await sleep(START_POLL_INTERVAL);
        if (await reachable()) {
          weStartedDocker = true;
          lastDockerUse = Date.now();
          log.info('Docker started by iClaw (will auto-stop when idle + empty)');
          return true;
        }
      }
      return false;
    })().finally(() => {
      ensureInFlight = null;
    });
  }
  return ensureInFlight;
}

/** Reset the idle-stop countdown — call whenever a container is used. */
export function markDockerUse(): void {
  lastDockerUse = Date.now();
}

/** Number of running containers, or -1 if the probe failed. */
async function runningContainerCount(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '-q'], { timeout: PROBE_TIMEOUT });
    return stdout.split('\n').filter((s) => s.trim()).length;
  } catch {
    return -1;
  }
}

async function quitDocker(): Promise<void> {
  const plat = osPlatform();
  try {
    if (plat === 'darwin') {
      await execFileAsync('osascript', ['-e', 'quit app "Docker"'], { timeout: 15_000 });
    } else if (plat === 'win32') {
      await execFileAsync('taskkill', ['/IM', 'Docker Desktop.exe', '/F'], { timeout: 15_000 });
    }
  } catch (err) {
    log.warn('Stopping Docker failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Background loop: stop Docker once it's been idle past IDLE_STOP_MS AND has no
 * running containers AND we were the ones who started it. The container check is
 * the key safety net — if the user (or one of our warm sandboxes) still has a
 * container up, we leave the daemon alone.
 */
export function startDockerIdleReaper(): void {
  setInterval(async () => {
    if (!weStartedDocker) return;
    if (Date.now() - lastDockerUse < IDLE_STOP_MS) return;
    const n = await runningContainerCount();
    if (n !== 0) return; // containers still running (or probe failed) → don't touch
    log.info('Docker idle + no containers — stopping the daemon we started');
    await quitDocker();
    weStartedDocker = false;
  }, REAPER_INTERVAL).unref();
}

/** Test/inspection helper. */
export function _state(): { weStartedDocker: boolean; lastDockerUse: number } {
  return { weStartedDocker, lastDockerUse };
}
