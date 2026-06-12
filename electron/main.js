'use strict';

/**
 * iClaw desktop shell (Electron, macOS-first).
 *
 * iClaw is a local Express web app: it listens on 127.0.0.1 and renders its UI
 * in a browser. The desktop shell doesn't reimplement any of that — it simply
 *
 *   1. spawns the SAME compiled server (dist/index.js) as a child process, run
 *      by a STOCK Node binary (NOT Electron-as-node), on a free port, in NON-CLI
 *      mode (no ICLAW_CLI) so it never prints a banner or opens an external
 *      browser — it just listens; and
 *   2. points a BrowserWindow at http://127.0.0.1:<port>.
 *
 * Why stock Node and not Electron's bundled Node (ELECTRON_RUN_AS_NODE): the
 * server loads a native module (better-sqlite3). Running it on Electron's Node
 * would force that module to be rebuilt against Electron's fast-moving V8 ABI
 * (Electron 42 ships a V8 newer than better-sqlite3 can compile against). Pinning
 * the server to a stock Node binary decouples our native modules from Electron's
 * V8 entirely — they use their normal Node prebuild — which is both simpler and
 * far less likely to break on an Electron bump. Electron stays a pure window.
 *
 * Secure Mode and Work Mode are unaffected: they run as separate docker/colima
 * subprocesses spawned by the runtime sidecar, and don't care what draws the
 * window. The one thing they DO need — a sane PATH under a GUI ".app" launch —
 * is already handled by ensureColimaEnv() in the runtime.
 *
 * The server child inherits this process's environment, so DOCKER_CONTEXT / PATH
 * tweaks done by the server + runtime still apply.
 */

const { app, BrowserWindow, shell, dialog, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const logger = require('./logger');

logger.init(); // tee shell + server output to ~/.iclaw/logs/desktop.log

// Root that holds the compiled server (dist/) + public/ + views/ + node_modules.
//  - dev (running `electron electron/main.js`): the repo root, one level up.
//  - packaged: Resources/server/ (server payload shipped as plain files via
//    electron-builder extraResources — see electron-builder.yml).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'index.js');

// Stock Node binary that runs the server + runtime (decoupled from Electron's V8
// — see header). dev: the `node` on PATH; packaged: a Node bundled under
// Resources/node (set up in M2). Override with ICLAW_NODE_BIN.
const NODE_BIN =
  process.env.ICLAW_NODE_BIN ||
  (app.isPackaged ? path.join(process.resourcesPath, 'node', 'bin', 'node') : 'node');

/** Persistent data dir — SAME location the CLI uses, so data survives updates. */
const DB_PATH =
  process.env.DB_PATH || path.join(os.homedir(), '.iclaw', 'data', 'iclaw.db');

let serverChild = null;
let mainWindow = null;
let quitting = false;

// First-launch welcome intro. Shown once (gated by a flag file next to the DB),
// then never again. It also doubles as a splash that masks the server boot.
const INTRO_FLAG = path.join(path.dirname(DB_PATH), '..', 'intro-seen');
function introSeen() {
  if (process.env.ICLAW_FORCE_INTRO === '1') return false; // dev: always show
  try { return fs.existsSync(INTRO_FLAG); } catch { return false; }
}
function markIntroSeen() {
  try {
    fs.mkdirSync(path.dirname(INTRO_FLAG), { recursive: true });
    fs.writeFileSync(INTRO_FLAG, new Date().toISOString());
  } catch (err) {
    logger.logError('[iclaw-intro] could not write flag:', err.message);
  }
}

/** A transparent, frameless, screen-sized window that plays electron/intro.html
 *  over the desktop (the particle wordmark assembles into "iClaw"). */
function createIntroWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, hasShadow: false, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'intro.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  return win;
}

/** Grab an OS-assigned free TCP port on the loopback interface. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the server's URL until it answers (any HTTP response) or we time out. */
function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('iClaw server did not start in time'));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    };
    tryOnce();
  });
}

/** Spawn the compiled iClaw server as a plain-Node child on `port`. */
function startServer(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    ICLAW_DESKTOP: '1', // marker: launched by the desktop shell
    DB_PATH,
  };
  delete env.ICLAW_CLI; // force non-CLI mode: no banner, no auto-browser, no lockfile
  delete env.ELECTRON_RUN_AS_NODE; // we run a real Node binary, not Electron-as-node

  logger.log('[iclaw-desktop] starting server', { node: NODE_BIN, entry: SERVER_ENTRY, port });
  serverChild = spawn(NODE_BIN, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  logger.attachChild(serverChild, '[iclaw] ');
  serverChild.on('exit', (code, signal) => {
    serverChild = null;
    if (!quitting) {
      logger.logError(`[iclaw-desktop] server exited (code=${code ?? signal}) — quitting`);
      app.quit();
    }
  });
}

async function createWindow() {
  // First launch: play the transparent particle intro over the desktop WHILE the
  // server boots, then reveal the main window. Later launches go straight in.
  const showIntro = !introSeen();
  let introWin = null;
  let introStart = 0;
  let mainReady = false;
  let skipRequested = false;
  let introFinished = false;

  function finishIntro() {
    if (introFinished) return;
    if (!mainReady) { skipRequested = true; return; } // skipped mid-boot — finish once ready
    introFinished = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); // reveal main first
    if (introWin && !introWin.isDestroyed()) {
      const w = introWin; let op = 1;
      const fade = setInterval(() => {
        if (w.isDestroyed()) { clearInterval(fade); return; }
        op -= 0.14;
        if (op <= 0) { clearInterval(fade); w.close(); }
        else { try { w.setOpacity(op); } catch (_) { /* window closing */ } }
      }, 22);
    }
    markIntroSeen();
  }

  if (showIntro) {
    introWin = createIntroWindow();
    introStart = Date.now();
    introWin.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === ' ' || input.key === 'Enter')) {
        finishIntro();
      }
    });
  }

  const port = await getFreePort();
  startServer(port);
  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(url);
  } catch (err) {
    dialog.showErrorBox('iClaw', `Could not start the iClaw server.\n\n${err.message}`);
    app.quit();
    return;
  }

  const winState = require('./window-state');
  const saved = winState.load(); // remembered size/position from last run

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(typeof saved.x === 'number' ? { x: saved.x, y: saved.y } : {}),
    minWidth: 880,
    minHeight: 600,
    title: 'iClaw',
    backgroundColor: '#0b0b0b',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (saved.maximized) mainWindow.maximize();
  winState.track(mainWindow); // persist size/position on resize/move/close

  // target=_blank / external links open in the user's real browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  // Cmd/Ctrl+N → new chat. Desktop only: in the browser this is the native
  // "new window" shortcut, which we don't (and can't) override — this handler
  // lives in the Electron main process, so it never affects browser usage.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && !input.alt && !input.shift && (input.key === 'n' || input.key === 'N')) {
      event.preventDefault();
      mainWindow.webContents
        .executeJavaScript(
          "(function(){var b=document.querySelector('.new-chat-btn');if(b){b.click();}else{location.assign('/');}})()",
        )
        .catch(() => {});
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    logger.log('[iclaw-desktop] window loaded', url);
    // Check GitHub Releases for a newer signed build (packaged builds only).
    require('./updater').initAutoUpdates(logger);
    mainReady = true;
    if (!showIntro) { mainWindow.show(); return; }
    if (skipRequested) { finishIntro(); return; }
    // Hold the intro long enough that the word fully assembles (~6.7s) AND lingers
    // a beat on the finished "iClaw" before revealing the app.
    const MIN_INTRO_MS = 9500;
    setTimeout(finishIntro, Math.max(0, MIN_INTRO_MS - (Date.now() - introStart)));
  });

  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance: a second launch focuses the existing window instead of
// starting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // v1: quit when the window closes (even on macOS) — keeps the lifecycle simple
  // and ensures the server child is torn down. Can revisit for a tray app later.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (serverChild) serverChild.kill('SIGTERM'); // server has a graceful SIGTERM handler
  });
}
