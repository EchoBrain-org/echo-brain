import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { NodePersonSessionCrypto } from '../src/adapters/security/node-person-session-crypto.js';

const KEY_ID =
  'sha256:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd';
const PLAINTEXT = Buffer.from('A'.repeat(43), 'ascii');
const AUTHENTICATED_DATA = Buffer.from(
  'authority-oidc-pkce-seal-aad-v1:test-attempt',
  'utf8',
);

function sealingKey(offset = 0): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => index + offset);
}

function unseal(
  adapter: NodePersonSessionCrypto,
  sealed: ReturnType<NodePersonSessionCrypto['seal']>,
  overrides: Partial<Parameters<NodePersonSessionCrypto['unseal']>[0]> = {},
): Uint8Array {
  return adapter.unseal({
    key_id: sealed.key_id,
    sealed_bytes: sealed.sealed_bytes,
    authenticated_data: AUTHENTICATED_DATA,
    ...overrides,
  });
}

describe('NodePersonSessionCrypto', () => {
  it('implements secure random, SHA-256, and the closed AES-256-GCM v1 envelope', () => {
    const key = sealingKey();
    const adapter = new NodePersonSessionCrypto(key);
    key.fill(255);

    const randomA = adapter.bytes('oidc_state', 32);
    const randomB = adapter.bytes('oidc_state', 32);
    expect(randomA).toHaveLength(32);
    expect(randomB).toHaveLength(32);
    expect(randomA).not.toEqual(randomB);
    expect(
      Buffer.from(adapter.sha256(Buffer.from('abc', 'ascii'))).toString('hex'),
    ).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const sealed = adapter.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    });
    expect(sealed.key_id).toBe(KEY_ID);
    expect(sealed.sealed_bytes[0]).toBe(1);
    expect(sealed.sealed_bytes).toHaveLength(1 + 12 + PLAINTEXT.length + 16);
    expect(
      Buffer.from(sealed.sealed_bytes).includes(PLAINTEXT),
    ).toBe(false);
    expect(Buffer.from(unseal(adapter, sealed))).toEqual(PLAINTEXT);

    const restarted = new NodePersonSessionCrypto(sealingKey());
    expect(Buffer.from(unseal(restarted, sealed))).toEqual(PLAINTEXT);
  });

  it('uses a fresh nonce so repeated plaintext and AAD produce different envelopes', () => {
    const adapter = new NodePersonSessionCrypto(sealingKey());
    const first = adapter.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    });
    const second = adapter.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    });

    expect(first.sealed_bytes).not.toEqual(second.sealed_bytes);
    expect(first.sealed_bytes.slice(1, 13)).not.toEqual(
      second.sealed_bytes.slice(1, 13),
    );
    expect(Buffer.from(unseal(adapter, first))).toEqual(PLAINTEXT);
    expect(Buffer.from(unseal(adapter, second))).toEqual(PLAINTEXT);
  });

  it.each([
    ['version', 0],
    ['nonce', 1],
    ['ciphertext', 13],
    ['authentication tag', 1 + 12 + PLAINTEXT.length],
  ])('rejects one-byte %s tampering', (_label, index) => {
    const adapter = new NodePersonSessionCrypto(sealingKey());
    const sealed = adapter.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    });
    const tampered = Uint8Array.from(sealed.sealed_bytes);
    tampered[index] = (tampered[index] ?? 0) ^ 1;

    expect(() => unseal(adapter, sealed, { sealed_bytes: tampered })).toThrow(
      'person session PKCE sealed value is invalid',
    );
  });

  it('rejects wrong AAD, key, key ID, and malformed envelopes', () => {
    const adapter = new NodePersonSessionCrypto(sealingKey());
    const other = new NodePersonSessionCrypto(sealingKey(1));
    const sealed = adapter.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    });
    const otherKeyId = other.seal({
      plaintext: PLAINTEXT,
      authenticated_data: AUTHENTICATED_DATA,
    }).key_id;

    expect(() =>
      unseal(adapter, sealed, {
        authenticated_data: Buffer.from('different AAD', 'utf8'),
      }),
    ).toThrow('person session PKCE sealed value is invalid');
    expect(() =>
      unseal(other, sealed, { key_id: otherKeyId }),
    ).toThrow('person session PKCE sealed value is invalid');
    expect(() =>
      unseal(adapter, sealed, { key_id: otherKeyId }),
    ).toThrow('person session PKCE sealed value is invalid');
    expect(() =>
      unseal(adapter, sealed, {
        sealed_bytes: sealed.sealed_bytes.slice(0, -1),
      }),
    ).toThrow('person session PKCE sealed value is invalid');
    expect(() =>
      unseal(adapter, sealed, {
        sealed_bytes: Uint8Array.from([...sealed.sealed_bytes, 0]),
      }),
    ).toThrow('person session PKCE sealed value is invalid');
  });

  it('requires an exact 32-byte persistent sealing key', () => {
    expect(() => new NodePersonSessionCrypto(new Uint8Array(31))).toThrow(
      'person session PKCE sealing key must be 32 bytes',
    );
    expect(() => new NodePersonSessionCrypto(new Uint8Array(33))).toThrow(
      'person session PKCE sealing key must be 32 bytes',
    );
  });
});
