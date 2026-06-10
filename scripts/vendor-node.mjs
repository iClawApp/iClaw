/**
 * vendor-node — stage a stock Node binary for bundling into the .app.
 *
 * The packaged iClaw server + runtime run on a STOCK Node binary (not Electron's
 * Node — see electron/main.js). That binary's ABI must match the better-sqlite3
 * build we ship, so by default we copy the very Node that installed/built
 * better-sqlite3 in this checkout: `process.execPath`. Override the source with
 * ICLAW_VENDOR_NODE (e.g. point at an official node-vX-darwin-arm64/bin/node).
 *
 * Output: vendor/node/bin/node — electron-builder maps vendor/node → Resources/node.
 */
import { mkdirSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = process.env.ICLAW_VENDOR_NODE || process.execPath;
const destDir = join(root, 'vendor', 'node', 'bin');
const dest = join(destDir, 'node');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
chmodSync(dest, 0o755);

const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
console.log(`[vendor-node] ${src} -> ${dest} (${mb} MB)`);
