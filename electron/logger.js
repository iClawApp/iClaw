'use strict';

/**
 * Desktop file logging.
 *
 * A packaged .app has no terminal, so everything the shell and the server child
 * print is ALSO appended to ~/.iclaw/logs/desktop.log. The previous run is kept
 * as desktop.log.1 (rotated when the live file passes ~5 MB). The file can be
 * read at any time — no need to relaunch the app to see what happened, and no
 * dependence on who launched it or whether a terminal was attached.
 *
 * Best-effort: if the log file can't be opened, the app still runs and still
 * prints to stdout/stderr — it just won't have a file copy.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG_DIR = process.env.ICLAW_LOG_DIR || path.join(os.homedir(), '.iclaw', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
const MAX_BYTES = 5 * 1024 * 1024;

let stream = null;

/** Open the log stream, rotating one backup if the live file got large. */
function init() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      }
    } catch {
      /* no existing file yet — fine */
    }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.write(
      `\n===== iClaw desktop started ${new Date().toISOString()} (pid ${process.pid}) =====\n`,
    );
  } catch {
    stream = null; // never block startup on logging
  }
}

function toFile(text) {
  if (stream) {
    try {
      stream.write(text);
    } catch {
      /* ignore */
    }
  }
}

/** Render one log arg: objects as compact JSON, everything else as-is. */
function fmt(a) {
  if (a !== null && typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/** Timestamped shell log line → console + file. */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(fmt).join(' ')}\n`;
  process.stdout.write(line);
  toFile(line);
}

/** Timestamped shell error line → console + file. */
function logError(...args) {
  const line = `[${new Date().toISOString()}] ERROR ${args.map(fmt).join(' ')}\n`;
  process.stderr.write(line);
  toFile(line);
}

/** Tee a child process's stdout + stderr (raw) to console + file, with a prefix. */
function attachChild(child, prefix = '[iclaw] ') {
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(prefix + chunk);
    toFile(prefix + chunk);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(prefix + chunk);
    toFile(prefix + chunk);
  });
}

module.exports = { init, log, logError, attachChild, LOG_FILE, LOG_DIR };
