/**
 * Manages the iclaw-runtime sidecar process lifecycle.
 *
 * Spawns packages/iclaw-runtime/src/index.ts via tsx when Work Mode is
 * needed. Restarts automatically on crash (up to MAX_RESTARTS times).
 * Shuts down cleanly with the main iClaw process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const RUNTIME_DIR = path.resolve(__dirname, '../../packages/iclaw-runtime');
const RUNTIME_ENTRY = path.join(RUNTIME_DIR, 'src/index.ts');
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

let child: ChildProcess | null = null;
let restartCount = 0;
let windowStart = Date.now();
let stopping = false;

function runtimeInstalled(): boolean {
  return fs.existsSync(RUNTIME_ENTRY);
}

function spawnRuntime(): void {
  if (stopping || !runtimeInstalled()) return;

  // tsx should be available — it's a devDependency of the root package
  child = spawn('npx', ['tsx', RUNTIME_ENTRY], {
    cwd: RUNTIME_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[iclaw-runtime] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[iclaw-runtime] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    const now = Date.now();
    if (now - windowStart > RESTART_WINDOW_MS) {
      restartCount = 0;
      windowStart = now;
    }
    restartCount++;

    if (restartCount > MAX_RESTARTS) {
      console.error(
        `[iclaw-runtime] crashed ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 1000}s — giving up`,
      );
      return;
    }

    const delay = Math.min(1000 * restartCount, 10_000);
    console.warn(
      `[iclaw-runtime] exited (code=${code ?? signal}) — restarting in ${delay}ms (attempt ${restartCount}/${MAX_RESTARTS})`,
    );
    setTimeout(spawnRuntime, delay).unref();
  });
}

export const runtimeProcess = {
  start(): void {
    if (!runtimeInstalled()) return;
    stopping = false;
    spawnRuntime();
  },

  stop(): void {
    stopping = true;
    if (child) {
      child.kill('SIGTERM');
      child = null;
    }
  },

  get running(): boolean {
    return child !== null && !stopping;
  },
};
