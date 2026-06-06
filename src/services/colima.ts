/**
 * Colima container engine (macOS).
 *
 * On macOS, iClaw runs its Docker workloads on Colima — a free, lightweight,
 * CLI-driven Docker engine in a small Linux VM — instead of Docker Desktop.
 * A non-technical user never has to think about it: iClaw installs Colima
 * (Homebrew), starts it on demand the first moment a task needs a container,
 * and stops it again when idle.
 *
 * iClaw owns a DEDICATED Colima profile ("iclaw") — its own VM — so it never
 * disturbs the user's other containers/profiles, and it pins its own `docker`
 * CLI calls to that profile's context via DOCKER_CONTEXT, leaving the user's
 * GLOBAL docker context untouched.
 *
 * Off macOS this module is dormant: callers gate every use on `isMac` (Linux:
 * user-managed dockerd; Windows: Docker Desktop).
 */
import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** True on macOS, where iClaw uses Colima as its container engine. */
export const isMac = osPlatform() === 'darwin';

/** Dedicated Colima profile iClaw owns (its own VM — never the user's other work). */
export const COLIMA_PROFILE = 'iclaw';
/** Docker context Colima creates for that profile (`colima start iclaw`). */
export const COLIMA_CONTEXT = `colima-${COLIMA_PROFILE}`;

/** Generous ceiling for a first `colima start` (downloads the guest image + boots). */
const START_TIMEOUT = 300_000;
const PROBE_TIMEOUT = 8_000;
const STOP_TIMEOUT = 60_000;

/**
 * Pin this process's (and its children's) `docker` CLI calls to iClaw's Colima
 * context, without touching the user's global docker context. Idempotent, and
 * honours an explicit DOCKER_CONTEXT already set in the environment. No-op off
 * macOS. Safe to call from every process entry point.
 */
export function ensureColimaRouting(): void {
  if (isMac && !process.env.DOCKER_CONTEXT) {
    process.env.DOCKER_CONTEXT = COLIMA_CONTEXT;
  }
}

/** Colima CLI present on PATH (the engine is installed). */
export async function colimaInstalled(): Promise<boolean> {
  try {
    await execFileAsync('colima', ['version'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start iClaw's Colima VM (creating it on first run). Blocks until the daemon is
 * ready; idempotent — "already running" is a success. First run can take ~1–2 min
 * (guest image download); subsequent starts ~20s.
 */
export async function colimaStart(): Promise<void> {
  await execFileAsync('colima', ['start', COLIMA_PROFILE], { timeout: START_TIMEOUT });
}

/** Stop iClaw's Colima VM (only ours — never the user's other profiles). */
export async function colimaStop(): Promise<void> {
  await execFileAsync('colima', ['stop', COLIMA_PROFILE], { timeout: STOP_TIMEOUT });
}
