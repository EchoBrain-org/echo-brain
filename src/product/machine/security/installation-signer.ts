import {
  assertP256LowS,
  verifyInstallationKeyDescriptor,
  verifyP256LowSSignature,
} from '@echo-brain/federation-protocol';
import type {
  InstallationKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';

export { verifyInstallationKeyDescriptor };
export type { InstallationKeyDescriptor };

/**
 * Machine-owned private-key lifecycle. Protocol packages know only public
 * descriptors and signatures; this port is implemented by an installation.
 */
export interface InstallationSigner {
  generate(installationId: string): Promise<InstallationKeyDescriptor>;
  inspect(installationId: string): Promise<InstallationKeyDescriptor | null>;
  sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer>;
  deleteOrphan?(
    installationId: string,
    expectedKeyId: Sha256Digest,
  ): Promise<boolean>;
}

export async function signWithInstallationKey(
  signer: InstallationSigner,
  installationId: string,
  expectedKeyId: Sha256Digest,
  message: Buffer,
): Promise<Buffer> {
  const descriptor = await signer.inspect(installationId);
  if (descriptor === null) {
    throw new Error('installation signing key is unavailable');
  }
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      'installation signing key descriptor belongs to a different installation',
    );
  }
  const publicKey = verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.key_id !== expectedKeyId) {
    throw new Error(
      'installation signing key does not match the active identity',
    );
  }
  const verificationMessage = Buffer.from(message);
  const signature = await signer.sign(
    installationId,
    Buffer.from(verificationMessage),
    expectedKeyId,
  );
  assertP256LowS(signature);
  if (!verifyP256LowSSignature(publicKey, verificationMessage, signature)) {
    throw new Error('installation signer returned an invalid signature');
  }
  return signature;
}
