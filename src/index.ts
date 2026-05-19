import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { attachWsServer } from './routes/ws';
import { openclaw } from './services/openclaw';
import { scheduler } from './services/scheduler';
import { gatewayEvents } from './services/gatewayEvents';
import {
  findAvailablePort,
  attachCliBrowserControls,
  findExistingInstance,
  isCliLaunch,
  openBrowser,
  printAlreadyRunningBanner,
  printMinimalListenLog,
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

function gracefulShutdown(
  server: Server,
  signal: 'SIGINT' | 'SIGTERM',
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  removeLockFileIfOwned();
  scheduler.stop();
  server.close(() => process.exit(signal === 'SIGINT' ? 130 : 0));
  setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 0), 3000).unref();
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
}

void main().catch((err) => {
  console.error('[iclaw] failed to start', err);
  process.exit(1);
});
