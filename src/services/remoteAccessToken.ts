/**
 * Relay access token — proves the client was given the full remote URL once.
 * Distinct from the iClaw passphrase (workspace login).
 *
 * Algorithm must match `iclaw-relay/src/tunnel/accessToken.ts`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_QUERY_PARAM = 'access';

const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function buildPublicAccessUrl(publicUrl: string, accessToken: string): string {
  const u = new URL(publicUrl);
  u.searchParams.set(ACCESS_QUERY_PARAM, accessToken);
  return u.toString();
}

/** For tests — constant-time compare of token to stored hash. */
export function verifyAccessToken(token: string, storedHash: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const computed = hashAccessToken(token);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}
