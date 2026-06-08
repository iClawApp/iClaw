/**
 * Colima container engine (macOS) — runtime copy.
 *
 * On macOS, iClaw runs its Docker workloads on Colima — a free, lightweight,
 * CLI-driven Docker engine in a small Linux VM — instead of Docker Desktop.
 * A non-technical user never has to think about it: iClaw installs Colima,
 * starts it on demand the first moment a task needs a container, and stops it
 * again when idle.
 *
 * Colima can arrive two ways (see scripts/install-docker.sh): via Homebrew when
 * it's present, or — on a clean Mac with no Homebrew — by downloading pinned
 * colima/lima/docker binaries into ~/.iclaw/engine. Either way iClaw owns a
 * DEDICATED Colima profile ("iclaw") — its own VM — so it never disturbs the
 * user's other containers/profiles, and it pins its own `docker` CLI calls to
 * that profile's context via DOCKER_CONTEXT, leaving the GLOBAL context alone.
 *
 * Off macOS this module is dormant: callers gate every use on `isMac` (Linux:
 * user-managed dockerd; Windows: Docker Desktop).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** True on macOS, where iClaw uses Colima as its container engine. */
export const isMac = osPlatform() === 'darwin';

/** Dedicated Colima profile iClaw owns (its own VM — never the user's other work). */
export const COLIMA_PROFILE = 'iclaw';
/** Docker context Colima creates for that profile (`colima start iclaw`). */
export const COLIMA_CONTEXT = `colima-${COLIMA_PROFILE}`;

/** Where the no-brew installer drops the downloaded engine binaries (colima, limactl, docker). */
export const ENGINE_BIN = join(
  process.env.ICLAW_ENGINE_DIR || join(homedir(), '.iclaw', 'engine'),
  'bin',
);

/** Generous ceiling for a first `colima start` (downloads the guest image + boots). */
const START_TIMEOUT = 300_000;
const PROBE_TIMEOUT = 8_000;
const STOP_TIMEOUT = 60_000;

/** Add a dir to PATH (front = higher priority) if it exists and isn't already there. */
function addToPath(dir: string, front: boolean): void {
  if (!existsSync(dir)) return;
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (parts.includes(dir)) return;
  process.env.PATH = front
    ? `${dir}${delimiter}${parts.join(delimiter)}`
    : `${parts.join(delimiter)}${delimiter}${dir}`;
}

/**
 * Set up this process's (and its children's) environment for iClaw's Colima
 * engine on macOS:
 *  - ensure Homebrew's bin dirs are on PATH (a GUI-launched .app starts with a
 *    minimal PATH that omits them, so a brew-installed colima/docker wouldn't be
 *    found otherwise), and
 *  - put our own downloaded engine bin (~/.iclaw/engine/bin) FIRST, so a no-brew
 *    install wins, and
 *  - pin every `docker` call to iClaw's Colima context, leaving the user's GLOBAL
 *    docker context untouched.
 * Idempotent; honours an explicit DOCKER_CONTEXT already in the environment.
 * No-op off macOS. Safe to call from every process entry point — and again right
 * after an install, to pick up freshly downloaded binaries.
 */
export function ensureColimaEnv(): void {
  if (!isMac) return;
  addToPath('/opt/homebrew/bin', false);
  addToPath('/usr/local/bin', false);
  addToPath(ENGINE_BIN, true); // our pinned binaries take priority
  if (!process.env.DOCKER_CONTEXT) {
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
