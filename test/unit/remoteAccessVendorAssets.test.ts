import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REQUIRED_VENDOR = [
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

describe('Remote Access vendor assets', () => {
  it('required public vendor files exist after postinstall', () => {
    const missing: string[] = [];
    for (const rel of REQUIRED_VENDOR) {
      if (!fs.existsSync(path.join(pkgRoot, rel))) missing.push(rel);
    }
    expect(
      missing,
      `Run npm install (postinstall copies vendor). Missing:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('noble hkdf.js is importable ESM (relative imports resolve)', () => {
    const hkdf = fs.readFileSync(path.join(pkgRoot, 'public/js/vendor/noble/hkdf.js'), 'utf8');
    expect(hkdf).toContain('from "./hmac.js"');
    expect(fs.existsSync(path.join(pkgRoot, 'public/js/vendor/noble/hmac.js'))).toBe(true);
  });
});
