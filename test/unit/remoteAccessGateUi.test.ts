import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderGateLoginPage } from '../../src/services/remoteAccessAuth';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readPublicJs(name: string): string {
  return fs.readFileSync(path.join(pkgRoot, 'public', 'js', name), 'utf8');
}

describe('Remote Access gate UI (OPAQUE)', () => {
  it('gate HTML always uses OPAQUE module and blocks native login POST target', () => {
    const html = renderGateLoginPage({ tunnelId: 't-ui-02', next: '/' });
    expect(html).toContain('meta name="iclaw-ra-e2e" content="true"');
    expect(html).toContain('ra-gate-opaque.mjs');
    expect(html).toContain('action="#"');
    expect(html).not.toContain('action="/__ra/login"');
  });

  it('ra-device-auth.js uses OPAQUE flow only', () => {
    const js = readPublicJs('ra-device-auth.js');
    expect(js).toContain('runOpaqueLogin');
    expect(js).toContain('iclawRaOpaqueLogin');
    expect(js).not.toContain('runLegacyLogin');
    expect(js).not.toMatch(/postJson\(['"]\/__ra\/login/);
  });

  it('ra-gate-opaque.mjs calls start/finish only', () => {
    const mjs = readPublicJs('ra-gate-opaque.mjs');
    expect(mjs).toContain('/__ra/opaque/login/start');
    expect(mjs).toContain('/__ra/opaque/login/finish');
    expect(mjs).not.toMatch(/postJson\(['"]\/__ra\/login/);
    expect(mjs).not.toMatch(/fetch\(['"]\/__ra\/login/);
    expect(mjs).not.toMatch(/console\.(log|debug|info)/);
  });

  it('gate public assets list includes OPAQUE vendor bundle paths', () => {
    const authSrc = fs.readFileSync(
      path.join(pkgRoot, 'src', 'services', 'remoteAccessAuth.ts'),
      'utf8',
    );
    expect(authSrc).toContain("'/js/ra-gate-opaque.mjs'");
    expect(authSrc).toContain("'/js/vendor/opaque/index.js'");
  });
});
