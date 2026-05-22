/**
 * POST /api/update/run — install latest @iclawapp/iclaw globally.
 * Output goes to the terminal where iClaw was started (stdio: inherit).
 * Localhost only.
 */

import { spawn } from 'node:child_process';
import { Router, type Request } from 'express';
import { isLocalhostRequest } from '../services/gatewayStart';

export const updateRouter = Router();

const NPM_PACKAGE = '@iclawapp/iclaw@latest';
const INSTALL_ARGS = ['install', '-g', NPM_PACKAGE] as const;

let updateRunning = false;

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

updateRouter.post('/run', (req, res) => {
  if (!isLocalhostRequest(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (updateRunning) {
    res.status(409).json({ error: 'update already in progress' });
    return;
  }

  updateRunning = true;
  const cmd = `npm install -g ${NPM_PACKAGE}`;
  console.log(`\n[iClaw] Update started: ${cmd}\n`);

  const child = spawn(npmCommand(), [...INSTALL_ARGS], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  res.json({ started: true, command: cmd });

  const finish = (code: number | null): void => {
    updateRunning = false;
    if (code === 0) {
      console.log(
        '\n[iClaw] Done. Close this window (Ctrl+C), then start iClaw again:\n  npx @iclawapp/iclaw\n',
      );
    } else {
      console.log(
        `\n[iClaw] Update did not finish. Try again or run:\n  npx @iclawapp/iclaw@latest\n`,
      );
    }
  };

  child.on('close', (code) => finish(code));
  child.on('error', (err) => {
    updateRunning = false;
    console.error('[iClaw] Update spawn error:', err.message);
  });
});
