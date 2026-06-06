/**
 * First-run environment detection for the welcome flow.
 *
 * The onboarding screen shows an HONEST background progress line while the user
 * reads the welcome copy / pastes their OpenRouter key. We do NOT install
 * anything here — the container engine (Colima on macOS) and the OpenClaw
 * gateway are installed elsewhere (the composer's Install button / the user).
 * What we CAN do without the user noticing:
 *   - probe whether Docker is reachable (`docker info`),
 *   - if it is and the Work/Safe sandbox base image is missing, pre-pull it in
 *     the background (the one genuinely slow step we can hide behind the key
 *     entry), and
 *   - probe whether the OpenClaw gateway is reachable (Full Power).
 *
 * Everything is best-effort and cached — the screen polls `getOnboardingEnv()`
 * for a status line, never blocking the actual "Continue" action.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { colimaInstalled, ensureColimaEnv, isMac } from './colima';
import { probeGateway } from './gatewayProbe';

const execFileAsync = promisify(execFile);

// macOS: probe Colima (iClaw's engine) — put it on PATH and route docker calls to
// its context.
ensureColimaEnv();

// Mirror work-container.ts's image resolution so onboarding agrees with what
// Work/Safe actually use. The canonical image is the prebuilt sandbox; the
// public base is only a last-resort fallback we pre-pull when NOTHING usable is
// present yet. If the user already has either, there is nothing to download.
const SANDBOX_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
/** Base image Work/Safe modes fall back to — public, so `docker pull` works on a fresh box. */
const FALLBACK_IMAGE = process.env.ICLAW_WORK_SLIM_IMAGE || 'node:22';

type DockerState =
  | 'unknown' // not probed yet
  | 'missing' // Docker binary not installed
  | 'stopped' // installed but daemon not running (and we couldn't start it)
  | 'starting' // installed, daemon down — we're trying to start it
  | 'pulling' // daemon up, downloading the sandbox image
  | 'ready'; // daemon up and an image is available

export interface OnboardingEnv {
  /** Docker engine + sandbox image readiness (gates Work / Safe work). */
  docker: DockerState;
  /** OpenClaw gateway reachable (gates Full Power / Execute). */
  openclaw: 'unknown' | 'connected' | 'off';
}

let state: OnboardingEnv = { docker: 'unknown', openclaw: 'unknown' };
let prepStarted = false;

/** Daemon reachable (`docker info` exits 0). */
async function dockerReachable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/** Engine installed: Colima on macOS, the Docker CLI elsewhere (daemon may be down). */
async function dockerInstalled(): Promise<boolean> {
  if (isMac) return colimaInstalled();
  try {
    await execFileAsync('docker', ['--version'], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/** Pull the fallback base image in the background, flipping docker → ready when done. */
function pullImageInBackground(image: string): void {
  state.docker = 'pulling';
  // 10 min ceiling — a slow connection on a multi-hundred-MB image.
  execFileAsync('docker', ['pull', image], { timeout: 600_000 })
    .then(() => {
      state.docker = 'ready';
    })
    .catch(() => {
      // Pull failed (offline, disk, daemon hiccup). `docker run` still
      // auto-pulls on first real use, so this is non-fatal — leave it as
      // 'pulling' is misleading, so report 'ready' (Docker is installed; the
      // image just arrives lazily later).
      state.docker = 'ready';
    });
}

/**
 * Daemon is up: mark ready if a usable image is already present, otherwise
 * pre-pull the public fallback in the background.
 */
async function ensureImage(): Promise<void> {
  if ((await imageExists(SANDBOX_IMAGE)) || (await imageExists(FALLBACK_IMAGE))) {
    state.docker = 'ready';
  } else {
    pullImageInBackground(FALLBACK_IMAGE);
  }
}

/**
 * Kick off detection + the (slow) image pre-pull exactly once. Safe to call on
 * every /welcome render — it no-ops after the first call.
 */
export function startOnboardingPrep(): void {
  if (prepStarted) return;
  prepStarted = true;

  void (async () => {
    // 1. Daemon already up (the user started it)? Pre-pull the sandbox image so
    //    the first Work/Safe use is fast.
    if (await dockerReachable()) {
      await ensureImage();
      return;
    }
    // 2. Installed but idle → DON'T start it here. Onboarding is informational;
    //    the runtime starts Docker on demand the moment a task needs it
    //    (docker-lifecycle.ts) and auto-stops it when idle. Starting it here
    //    instead would be a transparent start the runtime can't track → it would
    //    never get auto-stopped. So we just report the state.
    if (await dockerInstalled()) {
      state.docker = 'stopped';
      return;
    }
    // 3. Not installed at all.
    state.docker = 'missing';
  })();

  void (async () => {
    try {
      const { gatewayStatus } = await probeGateway('onboarding');
      state.openclaw = gatewayStatus === 'ok' ? 'connected' : 'off';
    } catch {
      state.openclaw = 'off';
    }
  })();
}

/** Current best-effort environment snapshot for the welcome progress line. */
export function getOnboardingEnv(): OnboardingEnv {
  return { ...state };
}
