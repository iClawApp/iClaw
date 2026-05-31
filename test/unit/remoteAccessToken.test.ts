import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  generateAccessToken,
  hashAccessToken,
  verifyAccessToken,
  buildPublicAccessUrl,
  ACCESS_QUERY_PARAM,
} from '../../src/services/remoteAccessToken';

// Cross-package parity with the relay's token hashing is only checkable when
// the sibling iclaw-relay repo is checked out next to this one (local dev). CI
// builds iClaw alone, so the relay source is absent — load it optionally and
// skip the parity assertion there instead of failing the whole suite on a
// missing module. (test/ is outside the tsc `include`, so this dynamic import
// isn't type-checked; it simply rejects at runtime when the relay is absent.)
let relayHashAccessToken: ((token: string) => string) | null = null;
try {
  const relayModule = (await import('../../../iclaw-relay/src/tunnel/accessToken')) as {
    hashAccessToken: (token: string) => string;
  };
  relayHashAccessToken = relayModule.hashAccessToken;
} catch {
  relayHashAccessToken = null;
}

const FIXTURE_TOKEN = randomBytes(32).toString('base64url');
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_TOKEN, 'utf8').digest('base64url');

describe('remoteAccessToken', () => {
  it('generates 32-byte base64url tokens', () => {
    const token = generateAccessToken();
    expect(token.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it('hashAccessToken produces the documented sha256/base64url hash', () => {
    expect(hashAccessToken(FIXTURE_TOKEN)).toBe(FIXTURE_HASH);
  });

  it.skipIf(!relayHashAccessToken)(
    'matches relay hash algorithm (cross-package parity)',
    () => {
      expect(relayHashAccessToken!(FIXTURE_TOKEN)).toBe(FIXTURE_HASH);
      expect(hashAccessToken(FIXTURE_TOKEN)).toBe(relayHashAccessToken!(FIXTURE_TOKEN));
    },
  );

  it('verifyAccessToken accepts matching hash only', () => {
    expect(verifyAccessToken(FIXTURE_TOKEN, FIXTURE_HASH)).toBe(true);
    expect(verifyAccessToken(FIXTURE_TOKEN + 'x', FIXTURE_HASH)).toBe(false);
    expect(verifyAccessToken('too-short', FIXTURE_HASH)).toBe(false);
  });

  it('builds public URL with access query param and preserves path', () => {
    const url = buildPublicAccessUrl('https://abc.iclaw.digital/app', FIXTURE_TOKEN);
    const u = new URL(url);
    expect(u.hostname).toBe('abc.iclaw.digital');
    expect(u.pathname).toBe('/app');
    expect(u.searchParams.get(ACCESS_QUERY_PARAM)).toBe(FIXTURE_TOKEN);
  });

  it('replaces existing access param when rebuilding URL', () => {
    const replacement = randomBytes(32).toString('base64url');
    const first = buildPublicAccessUrl('https://x.iclaw.digital/?access=old', replacement);
    const u = new URL(first);
    expect(u.searchParams.get(ACCESS_QUERY_PARAM)).toBe(replacement);
  });
});
