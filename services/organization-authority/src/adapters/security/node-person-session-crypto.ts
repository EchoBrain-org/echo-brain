import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  PersonSessionHashPort,
  PersonSessionPkceSeal,
  PersonSessionPkceSealer,
  PersonSessionRandomPurpose,
  PersonSessionRandomSource,
} from '../../application/ports/person-session-runtime.js';

const PKCE_SEAL_KEY_BYTES = 32;
const PKCE_SEAL_NONCE_BYTES = 12;
const PKCE_SEAL_TAG_BYTES = 16;
const PKCE_SEAL_VERSION = 1;
const PKCE_SEAL_HEADER_BYTES = 1;
const PKCE_SEAL_OVERHEAD_BYTES =
  PKCE_SEAL_HEADER_BYTES + PKCE_SEAL_NONCE_BYTES + PKCE_SEAL_TAG_BYTES;
const INVALID_PKCE_SEAL = 'person session PKCE sealed value is invalid';

function invalidPkceSeal(): Error {
  return new Error(INVALID_PKCE_SEAL);
}

/** Node-backed random, hashing, and single-key PKCE sealing for Person sessions. */
export class NodePersonSessionCrypto
  implements
    PersonSessionRandomSource,
    PersonSessionHashPort,
    PersonSessionPkceSealer
{
  private readonly pkceSealingKey: Buffer;
  private readonly pkceSealingKeyId: string;

  constructor(pkceSealingKey: Uint8Array) {
    if (
      !(pkceSealingKey instanceof Uint8Array) ||
      pkceSealingKey.byteLength !== PKCE_SEAL_KEY_BYTES
    ) {
      throw new Error('person session PKCE sealing key must be 32 bytes');
    }
    this.pkceSealingKey = Buffer.from(pkceSealingKey);
    this.pkceSealingKeyId = `sha256:${createHash('sha256')
      .update(this.pkceSealingKey)
      .digest('hex')}`;
  }

  bytes(_purpose: PersonSessionRandomPurpose, length: number): Uint8Array {
    return Uint8Array.from(randomBytes(length));
  }

  sha256(value: Uint8Array): Uint8Array {
    return Uint8Array.from(createHash('sha256').update(value).digest());
  }

  seal(input: {
    plaintext: Uint8Array;
    authenticated_data: Uint8Array;
  }): PersonSessionPkceSeal {
    const nonce = randomBytes(PKCE_SEAL_NONCE_BYTES);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.pkceSealingKey,
      nonce,
      { authTagLength: PKCE_SEAL_TAG_BYTES },
    );
    cipher.setAAD(input.authenticated_data);
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      key_id: this.pkceSealingKeyId,
      sealed_bytes: Uint8Array.from(
        Buffer.concat([
          Buffer.from([PKCE_SEAL_VERSION]),
          nonce,
          ciphertext,
          tag,
        ]),
      ),
    };
  }

  unseal(input: {
    key_id: string;
    sealed_bytes: Uint8Array;
    authenticated_data: Uint8Array;
  }): Uint8Array {
    if (
      input.key_id !== this.pkceSealingKeyId ||
      !(input.sealed_bytes instanceof Uint8Array) ||
      input.sealed_bytes.byteLength < PKCE_SEAL_OVERHEAD_BYTES
    ) {
      throw invalidPkceSeal();
    }
    const sealed = Buffer.from(input.sealed_bytes);
    if (sealed[0] !== PKCE_SEAL_VERSION) throw invalidPkceSeal();

    const nonceStart = PKCE_SEAL_HEADER_BYTES;
    const ciphertextStart = nonceStart + PKCE_SEAL_NONCE_BYTES;
    const tagStart = sealed.byteLength - PKCE_SEAL_TAG_BYTES;
    const nonce = sealed.subarray(nonceStart, ciphertextStart);
    const ciphertext = sealed.subarray(ciphertextStart, tagStart);
    const tag = sealed.subarray(tagStart);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.pkceSealingKey,
        nonce,
        { authTagLength: PKCE_SEAL_TAG_BYTES },
      );
      decipher.setAAD(input.authenticated_data);
      decipher.setAuthTag(tag);
      return Uint8Array.from(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    } catch {
      throw invalidPkceSeal();
    }
  }
}
