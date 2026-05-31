import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { defaultDbPath } from './paths';

/** Set by `bin/iclaw.js` for the `npx @iclawapp/iclaw` experience. */
export function isCliLaunch(): boolean {
  return process.env.ICLAW_CLI === '1';
}

/** Auto-open on start only when `ICLAW_OPEN_BROWSER=1` (default: use the terminal button). */
export function shouldAutoOpenBrowser(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  const v = process.env.ICLAW_OPEN_BROWSER?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Is a local GUI browser reachable on this machine?
 * macOS/Windows always have one; a Linux box only does inside a desktop
 * session (DISPLAY / WAYLAND_DISPLAY). A headless server has neither.
 */
export function hasLocalBrowser(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Should we offer the "use iClaw from another device" setup on startup?
 * Yes only when there's no local browser to open — i.e. a headless server.
 */
export function shouldOfferRemoteSetup(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  return !hasLocalBrowser();
}

/**
 * Ask a single [Y/n] question on the terminal; defaults to Yes on empty input.
 * Resolves `false` immediately when there's no interactive terminal (e.g. the
 * process was started by systemd/docker), so callers can fall back gracefully.
 */
export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

export interface InstanceLockData {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export function lockFilePath(): string {
  const dbPath = process.env.DB_PATH
    ? path.isAbsolute(process.env.DB_PATH)
      ? process.env.DB_PATH
      : path.resolve(process.cwd(), process.env.DB_PATH)
    : defaultDbPath();
  return path.join(path.dirname(dbPath), 'iclaw.lock.json');
}

export function readLockFile(): InstanceLockData | null {
  const file = lockFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceLockData;
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.port !== 'number' ||
      typeof raw.host !== 'string'
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeLockFile(data: InstanceLockData): void {
  const file = lockFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function removeLockFileIfOwned(): void {
  const data = readLockFile();
  if (data?.pid === process.pid) {
    try {
      fs.unlinkSync(lockFilePath());
    } catch {
      /* best-effort */
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/** True when something that looks like iClaw is serving on the lock's URL. */
export async function isIclawHttpUp(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  const url = `http://${host}:${port}/`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('iClaw');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLockReady(
  lock: InstanceLockData,
  attempts = 40,
  intervalMs = 250,
): Promise<InstanceLockData | null> {
  for (let i = 0; i < attempts; i++) {
    if (!isProcessAlive(lock.pid)) return null;
    const current = readLockFile();
    if (!current || current.pid !== lock.pid) return null;
    if (current.port > 0 && (await isIclawHttpUp(current.host, current.port))) {
      return current;
    }
    await sleep(intervalMs);
  }
  return null;
}

export async function findExistingInstance(): Promise<{
  url: string;
  lock: InstanceLockData;
} | null> {
  const lock = readLockFile();
  if (!lock) return null;
  if (!isProcessAlive(lock.pid)) {
    try {
      fs.unlinkSync(lockFilePath());
    } catch {
      /* stale */
    }
    return null;
  }

  if (lock.port === 0) {
    const ready = await waitForLockReady(lock);
    if (!ready) return null;
    return { url: `http://${ready.host}:${ready.port}`, lock: ready };
  }

  const up = await isIclawHttpUp(lock.host, lock.port);
  if (!up) {
    if (lock.pid !== process.pid) {
      try {
        fs.unlinkSync(lockFilePath());
      } catch {
        /* stale */
      }
    }
    return null;
  }
  return { url: `http://${lock.host}:${lock.port}`, lock };
}

export function tryClaimLockFile(): boolean {
  const file = lockFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const provisional: InstanceLockData = {
    pid: process.pid,
    port: 0,
    host: '127.0.0.1',
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(provisional, null, 2) + '\n', {
      flag: 'wx',
    });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EEXIST';
  }
}

export function releaseUninitializedLock(): void {
  const lock = readLockFile();
  if (lock?.pid === process.pid && lock.port === 0) {
    try {
      fs.unlinkSync(lockFilePath());
    } catch {
      /* best-effort */
    }
  }
}

const MAX_PORT_ATTEMPTS = 25;

/** First free port in `[preferred, preferred + MAX_PORT_ATTEMPTS)`. */
export async function findAvailablePort(preferred: number): Promise<number> {
  const base = Math.trunc(preferred);
  if (!Number.isFinite(base) || base < 1 || base > 65535) {
    throw new Error(`Invalid PORT: ${String(preferred)}`);
  }
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = base + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free port in range ${base}–${base + MAX_PORT_ATTEMPTS - 1}`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  /** Bright green — reads as lime on most terminals (macOS, Windows Terminal, Linux). */
  lime: '\x1b[92m',
  yellow: '\x1b[33m',
};

function useColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR !== '1';
}

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${c.reset}` : text;
}

/** Figlet "standard" — first CLI wordmark (mixed-case iClaw). */
const ICLAW_LOGO = [
  '  _  ____ _                ',
  ' (_)/ ___| | __ ___      __',
  ' | | |   | |/ _` \\ \\ /\\ / /',
  ' | | |___| | (_| |\\ V  V / ',
  ' |_|\\____|_|\\__,_| \\_/\\_/  ',
];

function terminalColumns(): number {
  return process.stdout.columns ?? 80;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function centerLine(text: string): string {
  const width = terminalColumns();
  const pad = Math.max(0, Math.floor((width - visibleLength(text)) / 2));
  return ' '.repeat(pad) + text;
}

function highlightKey(color: boolean, label: string): string {
  return paint(color, c.bold + c.lime, label);
}

const CLI_LIME = c.bold + c.lime;

const SHUTDOWN_LABEL = 'Stopping iClaw';
/** Fixed width so centered text does not shift between frames. */
const SHUTDOWN_LINE_WIDTH = SHUTDOWN_LABEL.length + 3;

function shutdownStatusLine(dotCount: number): string {
  const dots = '.'.repeat(dotCount % 4);
  return (SHUTDOWN_LABEL + dots).padEnd(SHUTDOWN_LINE_WIDTH, ' ');
}

const CLI_AIR = 5;

/** Extra blank lines above / below the CLI banner. */
function air(lines = CLI_AIR): void {
  for (let i = 0; i < lines; i++) console.log('');
}

function printCliFooter(url: string, color: boolean, showBrowserKey: boolean): void {
  air();
  console.log(centerLine(paint(color, c.lime, url)));
  air();
  if (showBrowserKey && process.stdin.isTTY) {
    console.log(
      centerLine(
        `Press ${highlightKey(color, 'g')} to open in browser`,
      ),
    );
  }
  console.log(
    centerLine(`${highlightKey(color, 'Ctrl+C')} to stop`),
  );
  air();
}

export interface StartupBannerOpts {
  url: string;
  gatewayUp: boolean;
  /** Show the "Press g to open in browser" hint — only when the raw-mode key
   *  controls are actually attached (real CLI launch, not tsx-watch dev). */
  controls: boolean;
}

/**
 * Animated shutdown line on TTY; returns cleanup that clears it before exit.
 * No-op animation when stdout is not a TTY.
 */
export function startCliShuttingDownAnimation(): () => void {
  const color = useColor();

  if (!process.stdout.isTTY) {
    console.log('');
    console.log(centerLine('Stopping iClaw...'));
    return () => {};
  }

  process.stdout.write('\n');
  let dotCount = 0;
  let interval: ReturnType<typeof setInterval> | undefined;

  const draw = (): void => {
    const text = shutdownStatusLine(dotCount);
    const msg = centerLine(paint(color, c.lime, text));
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(msg);
    dotCount++;
  };

  draw();
  interval = setInterval(draw, 400);

  return () => {
    if (interval) clearInterval(interval);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write('\x1b[K');
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    process.stdout.write('\r');
  };
}

/** Centered lime iClaw wordmark — shared by the banner and the onboarding. */
function printLogo(color: boolean): void {
  air();
  for (const line of ICLAW_LOGO) {
    console.log(centerLine(paint(color, c.lime, line)));
  }
}

export function printStartupBanner(opts: StartupBannerOpts): void {
  const color = useColor();
  printLogo(color);
  if (!opts.gatewayUp) {
    air();
    console.log(
      centerLine(
        paint(color, CLI_LIME, 'OpenClaw gateway not reachable'),
      ),
    );
  }
  printCliFooter(opts.url, color, opts.controls);
}

export function printAlreadyRunningBanner(url: string): void {
  const color = useColor();
  air();
  console.log(
    centerLine(paint(color, CLI_LIME, 'iClaw is already running')),
  );
  printCliFooter(url, color, false);
}

/* ------------------------------------------- remote-access onboarding -- */

/** Clear the screen for a clean onboarding transition (TTY only). */
function clearScreen(): void {
  if (process.stdout.isTTY) console.clear();
}

/**
 * Headless splash: logo + the "no browser → use from another device?" pitch.
 * The [Y/n] prompt itself is asked separately via promptYesNo().
 */
export function printRemoteOnboardingIntro(): void {
  const color = useColor();
  clearScreen();
  printLogo(color);
  air(2);
  console.log(centerLine('No browser here — looks like a server'));
  air(1);
  console.log(centerLine('Want to use iClaw from your phone or laptop?'));
  air(2);
  console.log(
    centerLine(`${highlightKey(color, '[Y]')} yes      ${highlightKey(color, '[N]')} no`),
  );
  air(1);
}

/** The reveal after Yes: link + password left-aligned (easy to copy). */
/** Transient "creating…" screen while the relay assigns the subdomain. */
export function printRemoteSettingUp(): void {
  const color = useColor();
  clearScreen();
  printLogo(color);
  air(2);
  console.log(centerLine('Setting up your private link…'));
  air(1);
}

export function printRemoteLinks(
  links: Array<{ url: string | null; passphrase: string; days: number }>,
): void {
  const color = useColor();
  clearScreen();
  printLogo(color);
  air(2);
  const multi = links.length > 1;
  const days1 = links[0]?.days ?? 30;
  console.log(
    centerLine(
      paint(
        color,
        CLI_LIME,
        multi
          ? 'Your private links'
          : `Your private link · next ${days1} day${days1 === 1 ? '' : 's'}`,
      ),
    ),
  );
  air(1);
  for (const l of links) {
    if (multi) console.log(centerLine(`— next ${l.days} day${l.days === 1 ? '' : 's'} —`));
    console.log(
      centerLine(
        l.url
          ? paint(color, c.lime, l.url)
          : '(waiting for the relay — press S again in a moment)',
      ),
    );
    console.log(centerLine('password:  ' + paint(color, c.bold, l.passphrase)));
    air(1);
  }
  console.log(
    centerLine(
      multi
        ? 'Open one on your phone or laptop and enter its password'
        : 'Open it on your phone or laptop and enter the password',
    ),
  );
  console.log(centerLine("End-to-end encrypted — even the relay can't read your traffic"));
  console.log(centerLine('Turn it off anytime in iClaw settings (in your browser)'));
  air(1);
}

/** The graceful "No" fallback — never a dead end (the controls footer follows). */
export function printRemoteNoFallback(): void {
  clearScreen();
  printLogo(useColor());
  air(2);
  console.log(centerLine('No problem — iClaw is running'));
  air(1);
}

/**
 * Controls footer for the headless terminal: press `S` to set up / re-show the
 * link right here, Ctrl+C to stop. Keeps everything in this one terminal so the
 * operator never needs a second window or a command to remember.
 */
export function printHeadlessControlsFooter(
  mode: 'none' | 'hidden' | 'shown',
  localUrl: string,
  linkCount = 0,
): void {
  const color = useColor();
  air(1);
  // On the resting screens (no link on screen) also surface the local address
  // — handy for SSH port-forwarding or a curl on the box. The link screen
  // stays focused on the public link, so we skip it there.
  if (mode !== 'shown') {
    console.log(centerLine('On this machine: ' + paint(color, c.lime, localUrl)));
    air(1);
    const action =
      mode === 'hidden'
        ? `show your ${linkCount} link${linkCount === 1 ? '' : 's'}`
        : 'set up a link for your phone or laptop';
    console.log(centerLine(`Press ${highlightKey(color, 'S')} to ${action}`));
  }
  console.log(centerLine(`${highlightKey(color, 'Ctrl+C')} to stop`));
  air(1);
}

/**
 * Keep the headless terminal interactive after onboarding: `S` runs the share
 * action (passed in) right here, Ctrl+C stops. No-op without a TTY. Mirrors
 * attachCliBrowserControls so the raw-mode handling stays consistent.
 */
export function attachHeadlessControls(opts: {
  onShare: () => void | Promise<void>;
  onStop: () => void;
}): void {
  if (!process.stdin.isTTY) return;
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const rl = readline.createInterface({ input: stdin, output: process.stdout });
  readline.emitKeypressEvents(stdin, rl);
  const wasRaw = stdin.isRaw;
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();

  // tsx-watch (npm run dev) restarts this process on every file change — make
  // sure raw mode is never left on, on any exit path, or the terminal breaks.
  const restoreRaw = (): void => {
    if (!wasRaw && stdin.isRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
  };
  process.once('exit', restoreRaw);

  let stopped = false;
  let busy = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stdin.off('keypress', onKeypress);
    if (!wasRaw && stdin.isRaw) stdin.setRawMode(false);
    rl.close();
    opts.onStop();
  };
  rl.on('SIGINT', stop);

  const onKeypress = (_str: string, key: readline.Key | undefined): void => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') {
      stop();
      return;
    }
    if (key.name === 's' && !busy) {
      busy = true;
      Promise.resolve(opts.onShare()).finally(() => {
        busy = false;
      });
    }
  };
  stdin.on('keypress', onKeypress);
}

/** Non-interactive headless (systemd/docker): a one-line log hint, no splash. */
export function printRemoteHeadlessHint(localUrl: string): void {
  const color = useColor();
  console.log('');
  console.log('  Headless server — remote access is off.');
  console.log(
    `  Reach iClaw at ${paint(color, c.lime, localUrl)} over SSH, or create a link with:  ${highlightKey(color, 'iclaw share')}`,
  );
  console.log('');
}

/** Restart with remote access already configured — styled confirmation screen. */
export function printRemoteAlreadyOn(): void {
  const color = useColor();
  clearScreen();
  printLogo(color);
  air(2);
  console.log(centerLine(paint(color, CLI_LIME, '✓ Remote access is on')));
  air(1);
}

/** Clean error screen if setting up the link fails (logo + the message). */
export function printRemoteError(message: string): void {
  clearScreen();
  printLogo(useColor());
  air(2);
  console.log(centerLine(message));
  air(1);
}

/** `g` hotkey opens the UI while the server keeps running. */
export function attachCliBrowserControls(
  url: string,
  onStop: () => void,
): void {
  if (shouldAutoOpenBrowser()) openBrowser(url);
  if (!process.stdin.isTTY) return;

  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const rl = readline.createInterface({ input: stdin, output: process.stdout });
  readline.emitKeypressEvents(stdin, rl);
  const wasRaw = stdin.isRaw;
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();

  // tsx-watch (npm run dev) restarts this process on every file change — make
  // sure raw mode is never left on, on any exit path, or the terminal breaks.
  const restoreRaw = (): void => {
    if (!wasRaw && stdin.isRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
  };
  process.once('exit', restoreRaw);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stdin.off('keypress', onKeypress);
    if (!wasRaw && stdin.isRaw) stdin.setRawMode(false);
    rl.close();
    onStop();
  };

  rl.on('SIGINT', stop);

  const onKeypress = (
    _str: string,
    key: readline.Key | undefined,
  ): void => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') {
      stop();
      return;
    }
    if (key.name === 'g') openBrowser(url);
  };

  stdin.on('keypress', onKeypress);
}

export function printMinimalListenLog(
  port: number,
  gatewayUrl: string,
  hasToken: boolean,
  tokenSource: string | null,
): void {
  console.log(`iClaw listening on http://127.0.0.1:${port}`);
  console.log(`  WebSocket on ws://127.0.0.1:${port}/ws`);
  console.log(
    `OpenClaw Gateway: ${gatewayUrl}` +
      ` (token: ${hasToken ? `loaded from ${tokenSource}` : 'NOT SET'})`,
  );
}

export function registerShutdownHooks(): void {
  process.on('exit', () => removeLockFileIfOwned());
}
