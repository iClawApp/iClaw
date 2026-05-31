import { describe, expect, it } from 'vitest';

import {
  decryptE2eRecord,
  deriveE2eSessionKeys,
  E2eCounterLedger,
  encryptE2eRecord,
  encodeWireEnvelope,
  decodeWireEnvelope,
} from '../../src/services/remoteAccessE2eCrypto';

const tunnelId = 't-e2etest01';
const relayBinding = new Uint8Array(32);
const opaqueKey = new Uint8Array(32).fill(7);

describe('remoteAccessE2eCrypto', () => {
  it('round-trips encrypt/decrypt client→server', () => {
    const keys = deriveE2eSessionKeys(opaqueKey, tunnelId, relayBinding);
    const ledger = new E2eCounterLedger();
    const inner = new TextEncoder().encode('{"method":"GET","path":"/"}');
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 'req-1',
      ctr: 0,
      kind: 'http-req',
      inner,
      relayBinding,
    });
    const plain = decryptE2eRecord(
      keys,
      'c2s',
      {
        tunnelId,
        streamId: 'req-1',
        ctr: 0,
        kind: 'http-req',
        ciphertext: ct,
        relayBinding,
      },
      ledger,
    );
    expect(plain?.inner).toEqual(inner);
  });

  it('rejects replayed counter', () => {
    const keys = deriveE2eSessionKeys(opaqueKey, tunnelId, relayBinding);
    const ledger = new E2eCounterLedger();
    const inner = new Uint8Array([1, 2, 3]);
    const ct0 = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 's1',
      ctr: 0,
      kind: 'ws-data',
      inner,
      relayBinding,
    });
    expect(
      decryptE2eRecord(
        keys,
        'c2s',
        {
          tunnelId,
          streamId: 's1',
          ctr: 0,
          kind: 'ws-data',
          ciphertext: ct0,
          relayBinding,
        },
        ledger,
      ),
    ).toBeTruthy();
    expect(
      decryptE2eRecord(
        keys,
        'c2s',
        {
          tunnelId,
          streamId: 's1',
          ctr: 0,
          kind: 'ws-data',
          ciphertext: ct0,
          relayBinding,
        },
        ledger,
      ),
    ).toBeNull();
  });

  it('rejects tampered ciphertext', () => {
    const keys = deriveE2eSessionKeys(opaqueKey, tunnelId, relayBinding);
    const ledger = new E2eCounterLedger();
    const ct = encryptE2eRecord(keys, 'c2s', {
      tunnelId,
      streamId: 's2',
      ctr: 0,
      kind: 'http-req',
      inner: new Uint8Array([9]),
      relayBinding,
    });
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 1] ^= 0xff;
    expect(
      decryptE2eRecord(
        keys,
        'c2s',
        {
          tunnelId,
          streamId: 's2',
          ctr: 0,
          kind: 'http-req',
          ciphertext: tampered,
          relayBinding,
        },
        ledger,
      ),
    ).toBeNull();
  });

  it('does NOT reuse keystream across streams (C1 regression)', () => {
    // Two different streams, same direction, same ctr=0, same plaintext.
    // With a per-stream subkey the ciphertexts MUST differ; if the key were
    // shared (the old bug) identical plaintext + identical (key,nonce) would
    // produce byte-identical ciphertext — the catastrophic GCM nonce reuse.
    const keys = deriveE2eSessionKeys(opaqueKey, tunnelId, relayBinding);
    const inner = new TextEncoder().encode('{"cookie":"iclaw_ra=secret"}');
    const common = { tunnelId, ctr: 0, kind: 'http-req' as const, inner, relayBinding };
    const ctA = encryptE2eRecord(keys, 'c2s', { ...common, streamId: 'stream-A' });
    const ctB = encryptE2eRecord(keys, 'c2s', { ...common, streamId: 'stream-B' });
    expect(Buffer.from(ctA).equals(Buffer.from(ctB))).toBe(false);

    // And a ciphertext from stream-B must not decrypt under stream-A's context
    // (key is bound to streamId), proving the subkeys are actually distinct.
    const ledger = new E2eCounterLedger();
    const wrong = decryptE2eRecord(
      keys,
      'c2s',
      { tunnelId, streamId: 'stream-A', ctr: 0, kind: 'http-req', ciphertext: ctB, relayBinding },
      ledger,
    );
    expect(wrong).toBeNull();
  });

  it('wire envelope round-trip', () => {
    const ct = new Uint8Array([1, 2, 3, 4]);
    const wire = encodeWireEnvelope({
      sid: 'th-test-handle01',
      ctr: 5,
      kind: 'http-res',
      streamId: 'r1',
      ciphertext: ct,
    });
    expect(wire).not.toContain('passphrase');
    const parsed = decodeWireEnvelope(wire);
    expect(parsed?.sid).toBe('th-test-handle01');
    expect(parsed?.ctr).toBe(5);
    expect(parsed?.ciphertext).toEqual(ct);
  });
});
