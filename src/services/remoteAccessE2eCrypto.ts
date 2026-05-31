/**
 * RA-E2E v1 transport crypto — AES-256-GCM with a per-(direction,streamId)
 * subkey and monotonic per-stream counters.
 *
 * Nonce uniqueness: the 12-byte GCM nonce is derived only from
 * (tunnelId, counter), so it repeats across streams that each start their
 * counter at 0. To keep (key, nonce) unique we derive a distinct AEAD key
 * per (direction, streamId) via HKDF from the direction key — so a repeated
 * nonce is always paired with a different key. Do NOT remove the subkey
 * derivation without also making the nonce stream-unique.
 * See docs/REMOTE_ACCESS.md
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const E2E_INFO = 'iClaw-ra-e2e-v1';

/**
 * Forward-gap tolerance for the per-stream counter ledger.
 *
 * The receiver expects monotonically increasing counters per (direction,
 * streamId). A counter `< expected` is always rejected (replay protection),
 * and accepting a counter advances `expected` to `ctr + 1` — so once a value
 * is seen, every value `<=` it is permanently rejected. MAX_CTR_SKIP only
 * widens how far AHEAD a counter may jump in one step, absorbing a few
 * dropped/coalesced frames without resyncing. It is NOT a replay window.
 *
 * Frames travel in order over a single TCP-backed WebSocket, so large skips
 * never occur in practice; 32 is a deliberately tight bound that still leaves
 * slack for benign gaps. Out-of-order frames inside the window are dropped,
 * not buffered.
 */
export const MAX_CTR_SKIP = 32;

/**
 * Upper bound on a frame counter. The 12-byte GCM nonce packs the counter as
 * a 64-bit LE integer, but it is carried through JS as a `number`; past
 * 2^53 (`Number.MAX_SAFE_INTEGER`) integer arithmetic loses precision and two
 * distinct logical counters could collapse to the same nonce. We fail closed
 * well before that — reaching even 2^32 frames on a single stream is already
 * unreachable in any real session.
 */
export const MAX_CTR = Number.MAX_SAFE_INTEGER;

export type E2eDirection = 'c2s' | 's2c';
export type E2eFrameKind = 'http-req' | 'http-res' | 'ws-open' | 'ws-data' | 'ws-close';

export interface E2ePlainRecord {
  v: 1;
  ctr: number;
  kind: E2eFrameKind;
  streamId: string;
  inner: Uint8Array;
}

export interface E2eSessionKeys {
  c2s: Uint8Array;
  s2c: Uint8Array;
}

export function relayAccessBindingHash(cookieValue: string | undefined): Uint8Array {
  if (!cookieValue) return new Uint8Array(32);
  return relayAccessBindingFromAccessToken(cookieValue);
}

/** SHA-256 of the raw relay ?access= token (matches browser sessionStorage binding). */
export function relayAccessBindingFromAccessToken(accessToken: string): Uint8Array {
  if (!accessToken) return new Uint8Array(32);
  return sha256(new TextEncoder().encode(accessToken));
}

/** Base64url relay binding for gate/workspace meta (matches browser HKDF salt). */
export function relayBindingB64urlForAccessToken(accessToken: string): string {
  return Buffer.from(relayAccessBindingFromAccessToken(accessToken)).toString('base64url');
}

export function deriveE2eSessionKeys(
  opaqueSessionKey: Uint8Array,
  tunnelId: string,
  relayBinding: Uint8Array,
): E2eSessionKeys {
  const salt = sha256(
    new TextEncoder().encode(`${tunnelId}\x00${Buffer.from(relayBinding).toString('base64url')}`),
  );
  const master = hkdf(sha256, opaqueSessionKey, salt, new TextEncoder().encode(E2E_INFO), 32);
  return {
    c2s: hkdf(sha256, master, undefined, new TextEncoder().encode('c2s'), 32),
    s2c: hkdf(sha256, master, undefined, new TextEncoder().encode('s2c'), 32),
  };
}

function keyForDirection(keys: E2eSessionKeys, dir: E2eDirection): Uint8Array {
  return dir === 'c2s' ? keys.c2s : keys.s2c;
}

/**
 * Per-(direction, streamId) AEAD subkey. Counters restart at 0 for every
 * new stream and the nonce only encodes (tunnelId, counter), so without a
 * distinct key per stream two streams would reuse (key, nonce) under GCM —
 * catastrophic. Binding the key to streamId removes that collision.
 * MUST match the browser implementation in ra-e2e-crypto.mjs.
 */
function deriveStreamKey(
  dirKey: Uint8Array,
  direction: E2eDirection,
  streamId: string,
): Uint8Array {
  return hkdf(
    sha256,
    dirKey,
    undefined,
    new TextEncoder().encode(`rec\x00${direction}\x00${streamId}`),
    32,
  );
}

function buildAad(opts: {
  tunnelId: string;
  streamId: string;
  direction: E2eDirection;
  ctr: number;
  kind: E2eFrameKind;
  relayBinding: Uint8Array;
}): Uint8Array {
  const ctrBuf = Buffer.alloc(8);
  ctrBuf.writeBigUInt64LE(BigInt(opts.ctr));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(opts.tunnelId, 'utf8'),
      Buffer.from([0]),
      Buffer.from(opts.streamId, 'utf8'),
      Buffer.from([0]),
      Buffer.from(opts.direction, 'utf8'),
      Buffer.from([0]),
      ctrBuf,
      Buffer.from([0]),
      Buffer.from(opts.kind, 'utf8'),
      Buffer.from([0]),
      Buffer.from(opts.relayBinding),
    ]),
  );
}

function encodePlainRecord(rec: E2ePlainRecord): Uint8Array {
  const innerB64 = Buffer.from(rec.inner).toString('base64url');
  const json = JSON.stringify({
    v: rec.v,
    ctr: rec.ctr,
    kind: rec.kind,
    streamId: rec.streamId,
    innerB64,
  });
  return new TextEncoder().encode(json);
}

function decodePlainRecord(bytes: Uint8Array): E2ePlainRecord | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: number;
      ctr?: number;
      kind?: E2eFrameKind;
      streamId?: string;
      innerB64?: string;
    };
    if (o.v !== 1 || typeof o.ctr !== 'number' || !o.kind || typeof o.streamId !== 'string') {
      return null;
    }
    if (typeof o.innerB64 !== 'string') return null;
    return {
      v: 1,
      ctr: o.ctr,
      kind: o.kind,
      streamId: o.streamId,
      inner: new Uint8Array(Buffer.from(o.innerB64, 'base64url')),
    };
  } catch {
    return null;
  }
}

/** 12-byte GCM nonce: tunnel-scoped prefix + 8-byte LE counter (deterministic for decrypt). */
function buildNonce(ctr: number, tunnelId: string): Buffer {
  const nonce = Buffer.alloc(12);
  Buffer.from(sha256(new TextEncoder().encode(tunnelId))).copy(nonce, 0, 0, 4);
  nonce.writeBigUInt64LE(BigInt(ctr), 4);
  return nonce;
}

function aesGcmEncrypt(key: Uint8Array, nonce: Buffer, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Buffer,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const buf = Buffer.from(ciphertext);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export class E2eCounterLedger {
  private readonly next = new Map<string, number>();

  private key(streamId: string, direction: E2eDirection): string {
    return `${direction}\x00${streamId}`;
  }

  checkAndAdvance(streamId: string, direction: E2eDirection, ctr: number): boolean {
    // Fail closed on malformed counters so the 64-bit nonce derivation never
    // sees a fractional/negative/precision-losing value (see MAX_CTR).
    if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr > MAX_CTR) return false;
    const k = this.key(streamId, direction);
    const expected = this.next.get(k) ?? 0;
    if (ctr < expected) return false;
    if (ctr > expected + MAX_CTR_SKIP) return false;
    this.next.set(k, ctr + 1);
    return true;
  }

  reset(): void {
    this.next.clear();
  }
}

export function encryptE2eRecord(
  keys: E2eSessionKeys,
  direction: E2eDirection,
  opts: {
    tunnelId: string;
    streamId: string;
    ctr: number;
    kind: E2eFrameKind;
    inner: Uint8Array;
    relayBinding: Uint8Array;
  },
): Uint8Array {
  const key = deriveStreamKey(keyForDirection(keys, direction), direction, opts.streamId);
  const plain: E2ePlainRecord = {
    v: 1,
    ctr: opts.ctr,
    kind: opts.kind,
    streamId: opts.streamId,
    inner: opts.inner,
  };
  const aad = buildAad({
    tunnelId: opts.tunnelId,
    streamId: opts.streamId,
    direction,
    ctr: opts.ctr,
    kind: opts.kind,
    relayBinding: opts.relayBinding,
  });
  const nonce = buildNonce(opts.ctr, opts.tunnelId);
  return new Uint8Array(aesGcmEncrypt(key, nonce, encodePlainRecord(plain), aad));
}

export function decryptE2eRecord(
  keys: E2eSessionKeys,
  direction: E2eDirection,
  opts: {
    tunnelId: string;
    streamId: string;
    ctr: number;
    kind: E2eFrameKind;
    ciphertext: Uint8Array;
    relayBinding: Uint8Array;
  },
  ledger: E2eCounterLedger,
): E2ePlainRecord | null {
  if (!ledger.checkAndAdvance(opts.streamId, direction, opts.ctr)) return null;
  const key = deriveStreamKey(keyForDirection(keys, direction), direction, opts.streamId);
  const aad = buildAad({
    tunnelId: opts.tunnelId,
    streamId: opts.streamId,
    direction,
    ctr: opts.ctr,
    kind: opts.kind,
    relayBinding: opts.relayBinding,
  });
  const nonce = buildNonce(opts.ctr, opts.tunnelId);
  let plainBytes: Uint8Array;
  try {
    plainBytes = new Uint8Array(aesGcmDecrypt(key, nonce, opts.ciphertext, aad));
  } catch {
    return null;
  }
  const rec = decodePlainRecord(plainBytes);
  if (!rec || rec.ctr !== opts.ctr || rec.kind !== opts.kind || rec.streamId !== opts.streamId) {
    return null;
  }
  return rec;
}

/** Parse outer envelope sent on the wire (base64url ciphertext + metadata). */
export function encodeWireEnvelope(opts: {
  sid: string;
  ctr: number;
  kind: E2eFrameKind;
  streamId: string;
  ciphertext: Uint8Array;
}): string {
  return JSON.stringify({
    v: 1,
    sid: opts.sid,
    ctr: opts.ctr,
    kind: opts.kind,
    streamId: opts.streamId,
    ct: Buffer.from(opts.ciphertext).toString('base64url'),
  });
}

export function decodeWireEnvelope(raw: string): {
  sid: string;
  ctr: number;
  kind: E2eFrameKind;
  streamId: string;
  ciphertext: Uint8Array;
} | null {
  try {
    const o = JSON.parse(raw) as {
      v?: number;
      sid?: string;
      ctr?: number;
      kind?: E2eFrameKind;
      streamId?: string;
      ct?: string;
    };
    if (
      o.v !== 1 ||
      typeof o.sid !== 'string' ||
      typeof o.ctr !== 'number' ||
      !o.kind ||
      typeof o.streamId !== 'string'
    ) {
      return null;
    }
    if (typeof o.ct !== 'string') return null;
    return {
      sid: o.sid,
      ctr: o.ctr,
      kind: o.kind,
      streamId: o.streamId,
      ciphertext: new Uint8Array(Buffer.from(o.ct, 'base64url')),
    };
  } catch {
    return null;
  }
}

export function hashForLogSafe(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
}
