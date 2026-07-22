import { createSignedDocumentWithKey as createProtocolSignedDocumentWithKey } from '@echo-brain/federation-protocol';
import type { Sha256Digest, SignedIntegrity } from '../contracts.js';
import type { InstallationSigner } from './installation-signer.js';
import { signWithInstallationKey } from './installation-signer.js';

export {
  createSignedDocumentWithKey,
  signedPayload,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';

/** Bind the portable signed-document primitive to a machine-local signer. */
export async function createSignedDocument<T extends object>(
  payload: T,
  signer: InstallationSigner,
  installationId: string,
  keyId: Sha256Digest,
): Promise<T & { integrity: SignedIntegrity }> {
  return createProtocolSignedDocumentWithKey(payload, keyId, (bytes) =>
    signWithInstallationKey(signer, installationId, keyId, bytes),
  );
}
