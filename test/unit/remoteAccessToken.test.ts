import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  generateAccessToken,
  hashAccessToken,
  verifyAccessToken,
  buildPublicAccessUrl,
  ACCESS_QUERY_PARAM,
} from '../../src/services/remoteAccessToken';
import { hashAccessToken as relayHashAccessToken } from '../../../iclaw-relay/src/tunnel/accessToken';

const FIXTURE_TOKEN = randomBytes(32).toString('base64url');
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_TOKEN, 'utf8').digest('base64url');

describe('remoteAccessToken', () => {
  it('generates 32-byte base64url tokens', () => {
    const token = generateAccessToken();
    expect(token.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it('matches relay hash algorithm (cross-package parity)', () => {
    expect(hashAccessToken(FIXTURE_TOKEN)).toBe(FIXTURE_HASH);
    expect(relayHashAccessToken(FIXTURE_TOKEN)).toBe(FIXTURE_HASH);
    expect(hashAccessToken(FIXTURE_TOKEN)).toBe(relayHashAccessToken(FIXTURE_TOKEN));
  });

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
