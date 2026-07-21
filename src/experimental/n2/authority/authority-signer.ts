import { createPublicKey } from 'node:crypto';
import type { Sha256Digest } from '../../../product/federation/contracts.js';
import type { OrganizationAuthorityDescriptorV1 } from '../contracts.js';
import { assertFederationId } from '../../../product/federation/foundation/identifiers.js';
import {
  assertP256LowS,
  p256KeyId,
  verifyP256LowSSignature,
} from '../../../product/federation/foundation/signature-profile.js';

export interface OrganizationAuthoritySigner {
  inspect(): Promise<OrganizationAuthorityDescriptorV1>;
  sign(message: Buffer, expectedKeyId?: Sha256Digest): Promise<Buffer>;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

export function verifyOrganizationAuthorityDescriptor(
  descriptor: OrganizationAuthorityDescriptorV1,
): Buffer {
  assertExactKeys(
    descriptor,
    [
      'schema_version',
      'kind',
      'authority_id',
      'organization_id',
      'signing_key',
    ],
    'organization authority descriptor',
  );
  assertExactKeys(
    descriptor.signing_key,
    ['key_id', 'algorithm', 'public_key_spki_der_base64'],
    'organization authority signing key',
  );
  assertFederationId(descriptor.authority_id, 'oau', 'authority_id');
  assertFederationId(
    descriptor.organization_id,
    'org',
    'authority organization_id',
  );
  if (
    descriptor.schema_version !== 1 ||
    descriptor.kind !== 'echo-organization-authority' ||
    descriptor.signing_key.algorithm !== 'ecdsa-p256-sha256-der-low-s'
  ) {
    throw new Error('organization authority descriptor is unsupported');
  }
  const encoded = descriptor.signing_key.public_key_spki_der_base64;
  const publicKey = Buffer.from(encoded, 'base64');
  if (
    publicKey.length === 0 ||
    publicKey.toString('base64') !== encoded ||
    p256KeyId(publicKey) !== descriptor.signing_key.key_id
  ) {
    throw new Error('organization authority public key identity is invalid');
  }
  const parsed = createPublicKey({
    key: publicKey,
    format: 'der',
    type: 'spki',
  });
  const canonical = parsed.export({ type: 'spki', format: 'der' });
  if (
    parsed.asymmetricKeyType !== 'ec' ||
    parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    !Buffer.isBuffer(canonical) ||
    !canonical.equals(publicKey)
  ) {
    throw new Error(
      'organization authority public key must be canonical P-256 SPKI DER',
    );
  }
  return publicKey;
}

export async function signWithOrganizationAuthority(
  signer: OrganizationAuthoritySigner,
  expected: OrganizationAuthorityDescriptorV1,
  message: Buffer,
): Promise<Buffer> {
  const current = await signer.inspect();
  const publicKey = verifyOrganizationAuthorityDescriptor(current);
  if (
    current.authority_id !== expected.authority_id ||
    current.organization_id !== expected.organization_id ||
    current.signing_key.key_id !== expected.signing_key.key_id ||
    current.signing_key.public_key_spki_der_base64 !==
      expected.signing_key.public_key_spki_der_base64
  ) {
    throw new Error('organization authority signer descriptor changed');
  }
  const verificationMessage = Buffer.from(message);
  const signature = await signer.sign(
    Buffer.from(verificationMessage),
    expected.signing_key.key_id,
  );
  assertP256LowS(signature);
  if (!verifyP256LowSSignature(publicKey, verificationMessage, signature)) {
    throw new Error(
      'organization authority signer returned an invalid signature',
    );
  }
  return signature;
}
