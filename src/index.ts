import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { attachWsServer } from './routes/ws';
import { openclaw } from './services/openclaw';
import { scheduler } from './services/scheduler';
import { gatewayEvents } from './services/gatewayEvents';
import { remoteAccess } from './services/remoteAccess';
import { setBoundLocalAddress } from './services/localAddress';
import {
  findAvailablePort,
  attachCliBrowserControls,
  findExistingInstance,
  isCliLaunch,
  openBrowser,
  printAlreadyRunningBanner,
  printMinimalListenLog,
  startCliShuttingDownAnimation,
  printStartupBanner,
  registerShutdownHooks,
  shouldAutoOpenBrowser,
  releaseUninitializedLock,
  removeLockFileIfOwned,
  tryClaimLockFile,
  writeLockFile,
} from './startup';

const preferredPort = Number(process.env.PORT ?? 3000);
const host = '127.0.0.1';

let shuttingDown = false;
let clearShutdownUi: (() => void) | undefined;

function gracefulShutdown(
  server: Server,
  signal: 'SIGINT' | 'SIGTERM',
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (isCliLaunch()) {
    clearShutdownUi = startCliShuttingDownAnimation();
  }
  removeLockFileIfOwned();
  scheduler.stop();
  remoteAccess.shutdown();

  const exitCode = signal === 'SIGINT' ? 130 : 0;
  let exiting = false;
  const finish = (): void => {
    if (exiting) return;
    exiting = true;
    clearShutdownUi?.();
    clearShutdownUi = undefined;
    process.exit(exitCode);
  };

  server.close(() => finish());
  setTimeout(finish, 3000).unref();
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main(): Promise<void> {
  const cli = isCliLaunch();

  if (cli) {
    const existing = await findExistingInstance();
    if (existing) {
      printAlreadyRunningBanner(existing.url);
      if (shouldAutoOpenBrowser()) openBrowser(existing.url);
      return;
    }
    if (!tryClaimLockFile()) {
      const again = await findExistingInstance();
      if (again) {
        printAlreadyRunningBanner(again.url);
        if (shouldAutoOpenBrowser()) openBrowser(again.url);
        return;
      }
    }
  }

  registerShutdownHooks();

  let server: Server;

  const port = cli
    ? await findAvailablePort(preferredPort)
    : preferredPort;

  const app = createApp();
  server = createServer(app);
  attachWsServer(server);
  scheduler.start();
  gatewayEvents.start();

  const stop = () => gracefulShutdown(server, 'SIGINT');
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => gracefulShutdown(server, 'SIGTERM'));

  try {
    await listen(server, port);
  } catch (err) {
    if (cli) releaseUninitializedLock();
    throw err;
  }

  if (cli) {
    writeLockFile({
      pid: process.pid,
      port,
      host,
      startedAt: new Date().toISOString(),
    });
  }

  const url = `http://${host}:${port}`;
  const gatewayUp = await openclaw.health();

  if (cli) {
    printStartupBanner({ url, gatewayUp });
    attachCliBrowserControls(url, stop);
  } else {
    printMinimalListenLog(
      port,
      openclaw.baseUrl,
      openclaw.hasToken,
      openclaw.tokenSource,
    );
  }

  // Remote Access wiring. configure() locks in the relay URL + bound
  // address; resumeAll() reattaches any persisted tunnels that haven't
  // expired. Both are safe no-ops when there's nothing to do.
  setBoundLocalAddress({ host, port });
  const relayUrl = resolveRelayUrl();
  remoteAccess.configure({ relayUrl, localHost: host, localPort: port });
  remoteAccess.resumeAll();
}

/**
 * Default relay URL for UI-driven activation.
 *
 * Production default points at the public relay so Remote Access works
 * out of the box on a fresh install — no terminal, no second process.
 * Override with `ICLAW_RELAY_URL=ws://127.0.0.1:4100/tunnel` for local
 * dev against a relay running on the same machine.
 */
function resolveRelayUrl(): string {
  const envUrl = process.env.ICLAW_RELAY_URL;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      if (u.protocol === 'ws:' || u.protocol === 'wss:') return envUrl;
      console.warn(`[remote-access] ignoring ICLAW_RELAY_URL with bad protocol: ${u.protocol}`);
    } catch {
      console.warn(`[remote-access] ignoring ICLAW_RELAY_URL — not a valid URL: ${envUrl}`);
    }
  }
  return 'wss://relay.iclaw.digital/tunnel';
}

void main().catch((err) => {
  console.error('[iclaw] failed to start', err);
  process.exit(1);
});
