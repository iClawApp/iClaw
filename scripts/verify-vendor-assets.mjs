#!/usr/bin/env node
/**
 * Fail if Remote Access browser vendor assets are missing (postinstall / prepack).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED = [
  'public/js/vendor/opaque/index.js',
  'public/js/vendor/noble/hkdf.js',
  'public/js/vendor/noble/hmac.js',
  'public/js/vendor/noble/sha2.js',
  'public/js/vendor/noble/utils.js',
  'public/js/vendor/noble/_md.js',
  'public/js/vendor/noble/_u64.js',
  'public/js/ra-e2e-crypto.mjs',
  'public/js/ra-e2e-transport.mjs',
  'public/js/ra-gate-opaque.mjs',
];

const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length > 0) {
  console.error('[verify-vendor-assets] Missing files:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Run: node scripts/copy-opaque-vendor.mjs');
  process.exit(1);
}

console.log(`[verify-vendor-assets] OK — ${REQUIRED.length} required assets present`);
