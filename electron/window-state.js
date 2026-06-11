'use strict';

/**
 * Persist + restore the main window's size/position across launches, so iClaw
 * reopens where you left it. Stored as JSON in ~/.iclaw/window-state.json
 * (alongside the DB + logs). Best-effort — any read/write failure just falls
 * back to the default size, never blocks the window.
 *
 * A saved position is only restored if it still lands on a currently-connected
 * display (so unplugging an external monitor doesn't open the window offscreen).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { screen } = require('electron');

const FILE = path.join(os.homedir(), '.iclaw', 'window-state.json');
const DEFAULTS = { width: 1200, height: 820 };

/** Saved bounds merged over the defaults; x/y dropped if no longer on-screen. */
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      const visible = screen.getAllDisplays().some(({ bounds: b }) => {
        return s.x >= b.x && s.y >= b.y && s.x < b.x + b.width && s.y < b.y + b.height;
      });
      if (!visible) {
        delete s.x;
        delete s.y;
      }
    }
    return { ...DEFAULTS, ...s };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Start saving this window's bounds on resize/move/close (debounced). */
function track(win) {
  const save = () => {
    if (win.isDestroyed()) return;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(
        FILE,
        JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() }),
      );
    } catch {
      /* best-effort */
    }
  };
  let timer;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('close', save);
}

module.exports = { load, track };
