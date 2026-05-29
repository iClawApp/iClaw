#!/usr/bin/env node
/**
 * Copy browser vendor bundles for Remote Access E2E:
 * - @serenity-kit/opaque → public/js/vendor/opaque/
 * - @noble/hashes (hkdf + sha256 chain) → public/js/vendor/noble/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`[copy-opaque-vendor] ERROR: ${msg}`);
  process.exit(1);
}

/** Dangling `//# sourceMappingURL=…` comments — the .map files are not vendored. */
const SOURCEMAP_COMMENT_RE = /\n?[ \t]*\/\/# sourceMappingURL=.*$/gm;

function copyFileRequired(src, dest, label, { stripSourceMap = false } = {}) {
  if (!fs.existsSync(src)) {
    fail(`missing ${label}: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (stripSourceMap) {
    // Drop sourceMappingURL comments so browsers (and our test loader) don't
    // chase .map files we intentionally don't ship.
    const code = fs.readFileSync(src, 'utf8').replace(SOURCEMAP_COMMENT_RE, '');
    fs.writeFileSync(dest, code);
  } else {
    fs.copyFileSync(src, dest);
  }
}

/** @noble/hashes@2.x ships ESM at package root; older layouts used esm/. */
function resolveNobleFile(name) {
  const pkgRoot = path.join(root, 'node_modules', '@noble', 'hashes');
  const candidates = [
    path.join(pkgRoot, 'esm', name),
    path.join(pkgRoot, name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Minimal dependency closure for ra-e2e-crypto.mjs (hkdf + sha256). */
const NOBLE_BROWSER_FILES = ['hkdf.js', 'hmac.js', 'sha2.js', 'utils.js', '_md.js', '_u64.js'];

const opaqueSrc = path.join(root, 'node_modules', '@serenity-kit/opaque', 'esm', 'index.js');
const opaqueDest = path.join(root, 'public', 'js', 'vendor', 'opaque', 'index.js');

if (!fs.existsSync(path.join(root, 'node_modules', '@serenity-kit', 'opaque'))) {
  fail('@serenity-kit/opaque not installed — run npm install');
}

copyFileRequired(opaqueSrc, opaqueDest, 'opaque bundle', { stripSourceMap: true });
console.log('[copy-opaque-vendor] copied public/js/vendor/opaque/index.js');

const nobleDestDir = path.join(root, 'public', 'js', 'vendor', 'noble');
for (const name of NOBLE_BROWSER_FILES) {
  const src = resolveNobleFile(name);
  if (!src) {
    fail(`@noble/hashes file not found: ${name} (checked esm/ and package root)`);
  }
  copyFileRequired(src, path.join(nobleDestDir, name), `@noble/hashes ${name}`, {
    stripSourceMap: true,
  });
}

console.log(
  `[copy-opaque-vendor] copied ${NOBLE_BROWSER_FILES.length} @noble/hashes files to public/js/vendor/noble/`,
);
