/**
 * vendor-node — stage a stock Node binary to bundle into the .app.
 *
 * The packaged server + runtime run on THIS binary (not Electron's Node — see
 * electron/main.js), so its ABI MUST match the better-sqlite3 build we ship. We
 * therefore pin it to the EXACT version running this script (process.version) —
 * the same Node that installed better-sqlite3 in this checkout — and fetch the
 * official, STRIPPED release from nodejs.org (far smaller than a dev/nvm build:
 * ~65 MB vs ~127 MB), verifying its SHA-256.
 *
 *   ICLAW_NODE_VERSION   override the version (default: process.version)
 *   ICLAW_VENDOR_NODE    short-circuit: copy this exact binary instead
 *
 * Any failure (offline, missing release, hash mismatch) falls back to copying the
 * current process.execPath, so a build never breaks for lack of a download.
 *
 * Output: vendor/node/bin/node — electron-builder maps vendor/node -> Resources/node.
 */
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  createReadStream,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const destDir = join(root, 'vendor', 'node', 'bin');
const dest = join(destDir, 'node');
mkdirSync(destDir, { recursive: true });

function install(src, why) {
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  const mb = (statSync(dest).size / 1048576).toFixed(1);
  console.log(`[vendor-node] ${why} (${mb} MB)`);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Explicit binary override — copy it verbatim, no download.
if (process.env.ICLAW_VENDOR_NODE) {
  install(process.env.ICLAW_VENDOR_NODE, `override ${process.env.ICLAW_VENDOR_NODE}`);
  process.exit(0);
}

const version = process.env.ICLAW_NODE_VERSION || process.version; // e.g. v25.9.0
const arch = process.arch; // arm64 | x64
const name = `node-${version}-darwin-${arch}`;
const tarball = `${name}.tar.gz`;
const baseUrl = `https://nodejs.org/dist/${version}`;
const cacheDir = join(root, 'vendor', 'cache');
mkdirSync(cacheDir, { recursive: true });
const tarPath = join(cacheDir, tarball);

try {
  if (!existsSync(tarPath)) {
    execFileSync('curl', ['-fsSL', '-o', tarPath, `${baseUrl}/${tarball}`], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 180_000,
    });
  }
  const sums = execFileSync('curl', ['-fsSL', `${baseUrl}/SHASUMS256.txt`], {
    timeout: 60_000,
  }).toString();
  const expected = sums
    .split('\n')
    .find((l) => l.trim().endsWith(` ${tarball}`) || l.trim().endsWith(`*${tarball}`))
    ?.trim()
    .split(/\s+/)[0];
  if (!expected) throw new Error(`no SHASUMS256 entry for ${tarball}`);
  const actual = await sha256(tarPath);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${tarball}`);

  execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir, `${name}/bin/node`], {
    timeout: 60_000,
  });
  install(join(cacheDir, name, 'bin', 'node'), `official ${version} ${arch} (sha-256 verified)`);
} catch (err) {
  console.warn(
    `[vendor-node] official download failed (${err.message}) — falling back to process.execPath`,
  );
  install(process.execPath, 'fallback: process.execPath');
}
