/**
 * Ed25519 challenge verification for Remote Access trusted devices.
 * Public keys are SPKI DER, base64url (exported from WebCrypto in the browser).
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const SPKI_B64URL_RE = /^[A-Za-z0-9_-]{40,256}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isValidDevicePublicKey(publicKeyB64: string): boolean {
  return SPKI_B64URL_RE.test(publicKeyB64);
}

export function isValidSignatureB64(signatureB64: string): boolean {
  return signatureB64.length >= 80 && signatureB64.length <= 128 && B64URL_RE.test(signatureB64);
}

function loadPublicKey(publicKeySpkiB64: string): KeyObject | null {
  if (!isValidDevicePublicKey(publicKeySpkiB64)) return null;
  try {
    return createPublicKey({
      key: Buffer.from(publicKeySpkiB64, 'base64url'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Verify Ed25519 signature over raw challenge bytes. */
export function verifyDeviceChallengeSignature(
  publicKeySpkiB64: string,
  challengeB64: string,
  signatureB64: string,
): boolean {
  if (!isValidSignatureB64(signatureB64)) return false;
  const key = loadPublicKey(publicKeySpkiB64);
  if (!key) return false;
  let challenge: Buffer;
  try {
    challenge = Buffer.from(challengeB64, 'base64url');
  } catch {
    return false;
  }
  if (challenge.length < 16 || challenge.length > 64) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64url');
  } catch {
    return false;
  }
  try {
    return verify(null, challenge, key, signature);
  } catch {
    return false;
  }
}
