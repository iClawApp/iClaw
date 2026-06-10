/**
 * Manages the iclaw-runtime sidecar process lifecycle.
 *
 * Runs the iclaw-runtime entry when Work Mode is needed, preferring the COMPILED
 * build (packages/iclaw-runtime/dist/index.js) launched with this process's own
 * Node (`process.execPath`) — so it needs no system node/npx/tsx on PATH, which
 * is exactly what a packaged desktop app can't assume. (The desktop shell runs
 * this server under a stock Node binary, so `process.execPath` is that Node.)
 * Only when no build exists (source checkout, `npm run dev`) does it fall back to
 * `npx tsx` on the TypeScript source. Restarts automatically on crash (up to
 * MAX_RESTARTS times). Shuts down cleanly with the main iClaw process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { kvGet } from '../db/kv';

const RUNTIME_DIR = path.resolve(__dirname, '../../packages/iclaw-runtime');
const RUNTIME_ENTRY_TS = path.join(RUNTIME_DIR, 'src/index.ts');
const RUNTIME_ENTRY_DIST = path.join(RUNTIME_DIR, 'dist/index.js');
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

let child: ChildProcess | null = null;
let restartCount = 0;
let windowStart = Date.now();
let stopping = false;

function runtimeInstalled(): boolean {
  return fs.existsSync(RUNTIME_ENTRY_DIST) || fs.existsSync(RUNTIME_ENTRY_TS);
}

function spawnRuntime(): void {
  if (stopping || !runtimeInstalled()) return;

  // Pass OpenRouter key from iClaw's DB into the runtime environment
  const openRouterKey = (kvGet('openrouter.api_key') ?? '').trim();
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(openRouterKey ? { ICLAW_OPENROUTER_API_KEY: openRouterKey } : {}),
  };

  // Prefer the compiled build run by our own Node binary (no system node/npx/tsx
  // needed — critical inside a packaged .app). Fall back to tsx-on-source only
  // when there's no dist (dev / source checkout).
  const useDist = fs.existsSync(RUNTIME_ENTRY_DIST);
  child = useDist
    ? spawn(process.execPath, [RUNTIME_ENTRY_DIST], {
        cwd: RUNTIME_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runtimeEnv,
      })
    : spawn('npx', ['tsx', RUNTIME_ENTRY_TS], {
        cwd: RUNTIME_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runtimeEnv,
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

  /**
   * Restart so the runtime picks up a changed OpenRouter key (the key is read
   * from the DB at spawn and passed via env — a running runtime can't see a key
   * added/changed later, e.g. during onboarding). Safe to call even if the
   * runtime isn't running yet: it just starts it.
   */
  restart(): void {
    if (!runtimeInstalled()) return;
    this.stop();
    // Brief gap so port 7430 frees before respawn (the runtime also self-retries
    // on a busy port, so this is just to avoid the noisy "port in use" log).
    setTimeout(() => {
      stopping = false;
      spawnRuntime();
    }, 500).unref();
  },

  get running(): boolean {
    return child !== null && !stopping;
  },
};
