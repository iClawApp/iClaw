'use strict';

/**
 * Auto-update — electron-updater + GitHub Releases, restart-to-update.
 *
 * On launch (packaged builds only) iClaw checks its GitHub Releases for a newer
 * SIGNED build, downloads it in the background, and installs it the next time the
 * app quits (autoInstallOnAppQuit) — so the user just gets the new version on
 * their next launch, no prompts, no manual download.
 *
 * Requirements:
 *  - macOS Squirrel verifies the code signature, so updates only work on a SIGNED
 *    + (for distribution) notarized build — see build/entitlements.mac.plist and
 *    the `mac` + `publish` blocks in electron-builder.yml.
 *  - The feed (latest-mac.yml + the .zip) must be published to the GitHub release.
 *
 * Best-effort: any failure (offline, no release yet, module missing) is logged
 * and swallowed — it must never block or crash the app.
 */

const { app } = require('electron');
const path = require('node:path');

function initAutoUpdates(logger) {
  if (!app.isPackaged) {
    logger.log('[iclaw-update] dev build — auto-update disabled');
    return;
  }

  let autoUpdater;
  try {
    // The app dir ships no node_modules (we exclude it to avoid duplicating the
    // tree). electron-updater lives in the server payload, so load it from there.
    const mod = path.join(process.resourcesPath, 'server', 'node_modules', 'electron-updater');
    ({ autoUpdater } = require(mod));
  } catch (err) {
    logger.logError('[iclaw-update] electron-updater unavailable:', err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Route electron-updater's own logging into our desktop.log.
  autoUpdater.logger = {
    info: (m) => logger.log('[iclaw-update]', m),
    warn: (m) => logger.log('[iclaw-update] WARN', m),
    error: (m) => logger.logError('[iclaw-update]', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => logger.log('[iclaw-update] checking…'));
  autoUpdater.on('update-available', (info) =>
    logger.log('[iclaw-update] update available:', info?.version),
  );
  autoUpdater.on('update-not-available', () => logger.log('[iclaw-update] up to date'));
  autoUpdater.on('download-progress', (p) =>
    logger.log('[iclaw-update] downloading', `${Math.round(p?.percent ?? 0)}%`),
  );
  autoUpdater.on('update-downloaded', (info) =>
    logger.log('[iclaw-update] downloaded', info?.version, '— installs on quit'),
  );
  autoUpdater.on('error', (err) =>
    logger.logError('[iclaw-update]', err?.message || String(err)),
  );

  autoUpdater
    .checkForUpdates()
    .catch((err) => logger.logError('[iclaw-update] check failed:', err?.message || String(err)));
}

module.exports = { initAutoUpdates };
