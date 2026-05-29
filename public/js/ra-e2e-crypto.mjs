/**
 * Browser-side RA-E2E crypto (mirrors remoteAccessE2eCrypto.ts).
 */
import { hkdf } from '/js/vendor/noble/hkdf.js';
import { sha256 } from '/js/vendor/noble/sha2.js';

export const E2E_INFO = 'iClaw-ra-e2e-v1';
export const MAX_CTR_SKIP = 32;

const te = new TextEncoder();
const td = new TextDecoder();

export function relayBindingFromAccessToken(accessToken) {
  if (!accessToken) return new Uint8Array(32);
  return sha256(te.encode(accessToken));
}

function decodeOpaqueSessionKeyB64(sessionKeyB64) {
  const pad = sessionKeyB64.length % 4 === 0 ? '' : '='.repeat(4 - (sessionKeyB64.length % 4));
  const b64 = sessionKeyB64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function deriveE2eSessionKeys(opaqueSessionKeyB64, tunnelId, relayBinding) {
  const opaqueKey = decodeOpaqueSessionKeyB64(opaqueSessionKeyB64);
  if (opaqueKey.length !== 64) throw new Error('invalid OPAQUE session key');
  const saltInput = tunnelId + '\x00' + b64urlBytes(relayBinding);
  const salt = sha256(te.encode(saltInput));
  const master = hkdf(sha256, opaqueKey, salt, te.encode(E2E_INFO), 32);
  return {
    c2s: hkdf(sha256, master, undefined, te.encode('c2s'), 32),
    s2c: hkdf(sha256, master, undefined, te.encode('s2c'), 32),
  };
}

function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildAad(opts) {
  const ctrBuf = new ArrayBuffer(8);
  const view = new DataView(ctrBuf);
  view.setBigUint64(0, BigInt(opts.ctr), true);
  const parts = [
    te.encode(opts.tunnelId),
    new Uint8Array([0]),
    te.encode(opts.streamId),
    new Uint8Array([0]),
    te.encode(opts.direction),
    new Uint8Array([0]),
    new Uint8Array(ctrBuf),
    new Uint8Array([0]),
    te.encode(opts.kind),
    new Uint8Array([0]),
    opts.relayBinding,
  ];
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildNonce(ctr, tunnelId) {
  const nonce = new Uint8Array(12);
  const prefix = sha256(te.encode(tunnelId));
  nonce.set(prefix.subarray(0, 4), 0);
  const view = new DataView(nonce.buffer, nonce.byteOffset + 4, 8);
  view.setBigUint64(0, BigInt(ctr), true);
  return nonce;
}

function encodePlainRecord(rec) {
  return te.encode(
    JSON.stringify({
      v: rec.v,
      ctr: rec.ctr,
      kind: rec.kind,
      streamId: rec.streamId,
      innerB64: b64urlEncode(rec.inner),
    }),
  );
}

function decodePlainRecord(bytes) {
  try {
    const o = JSON.parse(td.decode(bytes));
    if (o.v !== 1 || typeof o.ctr !== 'number' || !o.kind || typeof o.streamId !== 'string') {
      return null;
    }
    if (typeof o.innerB64 !== 'string') return null;
    return {
      v: 1,
      ctr: o.ctr,
      kind: o.kind,
      streamId: o.streamId,
      inner: b64urlDecode(o.innerB64),
    };
  } catch {
    return null;
  }
}

async function importAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function aesGcmEncrypt(key, nonce, plaintext, aad) {
  const ck = await importAesKey(key);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    ck,
    plaintext,
  );
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(key, nonce, ciphertext, aad) {
  const ck = await importAesKey(key);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    ck,
    ciphertext,
  );
  return new Uint8Array(pt);
}

export class E2eCounterLedger {
  constructor() {
    this.next = new Map();
  }
  checkAndAdvance(streamId, direction, ctr) {
    const k = direction + '\x00' + streamId;
    const expected = this.next.get(k) ?? 0;
    if (ctr < expected) return false;
    if (ctr > expected + MAX_CTR_SKIP) return false;
    this.next.set(k, ctr + 1);
    return true;
  }
}

export async function encryptE2eRecord(keys, direction, opts) {
  const key = direction === 'c2s' ? keys.c2s : keys.s2c;
  const plain = {
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
  return aesGcmEncrypt(key, nonce, encodePlainRecord(plain), aad);
}

export async function decryptE2eRecord(keys, direction, opts, ledger) {
  if (!ledger.checkAndAdvance(opts.streamId, direction, opts.ctr)) return null;
  const key = direction === 'c2s' ? keys.c2s : keys.s2c;
  const aad = buildAad({
    tunnelId: opts.tunnelId,
    streamId: opts.streamId,
    direction,
    ctr: opts.ctr,
    kind: opts.kind,
    relayBinding: opts.relayBinding,
  });
  const nonce = buildNonce(opts.ctr, opts.tunnelId);
  let plainBytes;
  try {
    plainBytes = await aesGcmDecrypt(key, nonce, opts.ciphertext, aad);
  } catch {
    return null;
  }
  const rec = decodePlainRecord(plainBytes);
  if (!rec || rec.ctr !== opts.ctr || rec.kind !== opts.kind || rec.streamId !== opts.streamId) {
    return null;
  }
  return rec;
}

export function encodeWireEnvelope(opts) {
  return JSON.stringify({
    v: 1,
    sid: opts.sid,
    ctr: opts.ctr,
    kind: opts.kind,
    streamId: opts.streamId,
    ct: b64urlEncode(opts.ciphertext),
  });
}

export function decodeWireEnvelope(raw) {
  try {
    const o = JSON.parse(raw);
    if (
      o.v !== 1 ||
      typeof o.sid !== 'string' ||
      typeof o.ctr !== 'number' ||
      !o.kind ||
      typeof o.streamId !== 'string' ||
      typeof o.ct !== 'string'
    ) {
      return null;
    }
    return {
      sid: o.sid,
      ctr: o.ctr,
      kind: o.kind,
      streamId: o.streamId,
      ciphertext: b64urlDecode(o.ct),
    };
  } catch {
    return null;
  }
}
