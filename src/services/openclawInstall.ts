import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether the `openclaw` CLI is installed on this device.
 *
 * Probed once at startup and cached — `openclaw --version` is a subprocess, far
 * too heavy for the per-render callers (e.g. defaultComposerMode). Distinct from
 * "gateway reachable": OpenClaw can be installed but stopped, and Full Power
 * starts it on demand — so the default-mode choice keys off INSTALL, not health.
 *
 * Defaults to `false` until the probe resolves, so a device without OpenClaw
 * never momentarily defaults into a dead Full Power. A machine that HAS it is
 * primed at startup (and onboarding's human-time gap covers any race).
 */
let installed = false;
let probed = false;

export async function probeOpenClawInstalled(): Promise<boolean> {
  try {
    // Not installed → spawn rejects immediately (ENOENT); a present binary
    // returns fast. The timeout only guards a pathological hang.
    await execFileAsync('openclaw', ['--version'], { timeout: 3_000 });
    installed = true;
  } catch {
    installed = false;
  }
  probed = true;
  return installed;
}

/** Cached result of the startup probe. `false` until {@link probeOpenClawInstalled} runs. */
export function isOpenClawInstalled(): boolean {
  return installed;
}

/** True once the startup probe has completed at least once. */
export function openClawInstallProbed(): boolean {
  return probed;
}
