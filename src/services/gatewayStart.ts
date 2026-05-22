import { spawn } from 'node:child_process';
import type { Request } from 'express';
import { openclaw } from './openclaw';

let startInFlight: Promise<{ ready: boolean; error?: string }> | null = null;

export function isLocalhostRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? req.ip ?? '';
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1'
  );
}

export async function waitForGatewayHealth(
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await openclaw.health()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function spawnGatewayStart(): Promise<{
  code?: number | null;
  spawnError?: string;
}> {
  return new Promise((resolve) => {
    console.log('\n[iClaw] Starting OpenClaw: openclaw gateway start\n');
    const child = spawn('openclaw', ['gateway', 'start'], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => resolve({ code }));
    child.on('error', (err) => resolve({ spawnError: err.message }));
  });
}

/** Runs `openclaw gateway start` and waits until GET /health succeeds. */
export async function startOpenClawGateway(): Promise<{
  ready: boolean;
  error?: string;
}> {
  if (await openclaw.health()) return { ready: true };

  const spawned = await spawnGatewayStart();
  if (spawned.spawnError) {
    return { ready: false, error: spawned.spawnError };
  }
  if (spawned.code !== 0 && spawned.code != null) {
    console.warn(`[iClaw] openclaw gateway start exited with code ${spawned.code}`);
  }

  const ready = await waitForGatewayHealth();
  if (!ready) {
    return {
      ready: false,
      error: 'OpenClaw did not start in time — try again',
    };
  }
  console.log('\n[iClaw] OpenClaw gateway is up.\n');
  return { ready: true };
}

/** Single-flight wrapper for POST /api/gateway/start. */
export function queueGatewayStart(): Promise<{ ready: boolean; error?: string }> {
  if (startInFlight) return startInFlight;
  startInFlight = startOpenClawGateway().finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}
