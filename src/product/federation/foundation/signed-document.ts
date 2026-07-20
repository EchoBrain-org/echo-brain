import type { JsonObject } from '../../../core/index.js';
import { canonicalJsonBytes, canonicalSha256 } from './canonical-json.js';
import type { Sha256Digest, SignedDocument, SignedIntegrity } from '../contracts.js';
import type { InstallationSigner } from './installation-signer.js';
import { signWithInstallationKey } from './installation-signer.js';
import { verifyP256LowSSignature } from './signature-profile.js';

export function signedPayload<T extends SignedDocument>(document: T): JsonObject {
  const { integrity: _integrity, ...payload } = document;
  return payload as JsonObject;
}

export async function createSignedDocument<T extends object>(
  payload: T,
  signer: InstallationSigner,
  installationId: string,
  keyId: Sha256Digest,
): Promise<T & { integrity: SignedIntegrity }> {
  const bytes = canonicalJsonBytes(payload);
  const signature = await signWithInstallationKey(
    signer,
    installationId,
    keyId,
    bytes,
  );
  return {
    ...payload,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: canonicalSha256(payload),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: keyId,
      signature_base64: signature.toString('base64'),
    },
  };
}

export function verifySignedDocument(
  document: SignedDocument,
  publicKeySpkiDer: Buffer,
  expectedKeyId: Sha256Digest,
): void {
  if (document.integrity.canonicalization !== 'RFC8785') {
    throw new Error('signed document canonicalization is unsupported');
  }
  if (document.integrity.signature_algorithm !== 'ecdsa-p256-sha256-der-low-s') {
    throw new Error('signed document algorithm is unsupported');
  }
  if (document.integrity.key_id !== expectedKeyId) {
    throw new Error('signed document key does not match the active installation');
  }
  const payload = signedPayload(document);
  const bytes = canonicalJsonBytes(payload);
  if (canonicalSha256(payload) !== document.integrity.payload_sha256) {
    throw new Error('signed document payload digest does not match');
  }
  const signature = Buffer.from(document.integrity.signature_base64, 'base64');
  if (signature.length === 0 || signature.toString('base64') !== document.integrity.signature_base64) {
    throw new Error('signed document signature is not canonical base64');
  }
  if (!verifyP256LowSSignature(publicKeySpkiDer, bytes, signature)) {
    throw new Error('signed document signature is invalid');
  }
}
