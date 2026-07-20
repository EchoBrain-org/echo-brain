import type {
  LocalIdentityManifestV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentChallengeV1,
  OrganizationEnrollmentProofV1,
  PublicationPolicyV1,
} from '../contracts.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '../foundation/canonical-json.js';
import type { InstallationSigner } from '../foundation/installation-signer.js';
import { verifyInstallationKeyDescriptor } from '../foundation/installation-signer.js';
import {
  assertFederationDocumentSize,
  type FederationSchemaKind,
  validateFederationDocument,
} from '../schema-validation.js';
import {
  createSignedDocument,
  verifySignedDocument,
} from '../foundation/signed-document.js';
import { assertUtcMillisecondTimestamp } from '../foundation/identifiers.js';
import { verifyOrganizationAuthorityDescriptor } from './authority-signer.js';

function validatedSnapshot<T>(
  kind: FederationSchemaKind,
  value: unknown,
  label: string,
): T {
  const raw = canonicalJson(value);
  assertFederationDocumentSize(raw, label);
  return validateFederationDocument<T>(kind, parseCanonicalJson(raw));
}

export function verifiedManifestPublicKey(
  manifest: LocalIdentityManifestV1,
): Buffer {
  const signingKey = manifest.installation.signing_key;
  const publicKey = verifyInstallationKeyDescriptor({
    installation_id: manifest.installation.installation_id,
    key_id: signingKey.key_id,
    algorithm: signingKey.algorithm,
    public_key_spki_der_base64: signingKey.public_key_spki_der_base64,
    protection: signingKey.protection,
    assurance: signingKey.assurance,
    private_key_exportable: signingKey.protection === 'development-file',
  });
  verifySignedDocument(manifest, publicKey, signingKey.key_id);
  return publicKey;
}

export interface CreateOrganizationEnrollmentProofRequest {
  challenge: OrganizationEnrollmentChallengeV1;
  authority: OrganizationAuthorityDescriptorV1;
  manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
  signer: InstallationSigner;
  now?: string;
}

/** Proves possession of the exact installation key named by a signed challenge. */
export async function createOrganizationEnrollmentProof(
  request: CreateOrganizationEnrollmentProofRequest,
): Promise<OrganizationEnrollmentProofV1> {
  const challenge = validatedSnapshot<OrganizationEnrollmentChallengeV1>(
    'organization-enrollment-challenge',
    request.challenge,
    'organization enrollment challenge',
  );
  const manifest = validatedSnapshot<LocalIdentityManifestV1>(
    'local-identity-manifest',
    request.manifest,
    'organization enrollment identity manifest',
  );
  const authorityKey = verifyOrganizationAuthorityDescriptor(request.authority);
  const publicationPolicy = validatedSnapshot<PublicationPolicyV1>(
    'publication-policy',
    request.publication_policy,
    'organization enrollment publication policy',
  );
  if (
    challenge.authority_id !== request.authority.authority_id ||
    challenge.organization_id !== request.authority.organization_id
  ) {
    throw new Error('enrollment challenge belongs to another authority');
  }
  verifySignedDocument(
    challenge,
    authorityKey,
    request.authority.signing_key.key_id,
  );
  const manifestPublicKey = verifiedManifestPublicKey(manifest);
  verifySignedDocument(
    publicationPolicy,
    manifestPublicKey,
    manifest.installation.signing_key.key_id,
  );

  const now = request.now ?? new Date().toISOString();
  assertUtcMillisecondTimestamp(now, 'enrollment proof current time');
  if (now < challenge.issued_at || now >= challenge.expires_at) {
    throw new Error('organization enrollment challenge is not currently valid');
  }
  const installation = manifest.installation;
  if (
    challenge.organization_id !== manifest.organization.organization_id ||
    challenge.principal_id !== manifest.principal.principal_id ||
    challenge.membership_id !== manifest.membership.membership_id ||
    challenge.installation_id !== installation.installation_id ||
    challenge.installation_key_id !== installation.signing_key.key_id ||
    challenge.identity_manifest_id !== manifest.manifest_id ||
    challenge.identity_manifest_sha256 !== canonicalSha256(manifest) ||
    publicationPolicy.organization_id !==
      manifest.organization.organization_id ||
    publicationPolicy.identity_manifest_id !== manifest.manifest_id ||
    publicationPolicy.issued_by.installation_id !==
      installation.installation_id ||
    publicationPolicy.issued_by.key_id !== installation.signing_key.key_id ||
    publicationPolicy.effective_at < manifest.created_at ||
    challenge.publication_policy_id !== publicationPolicy.policy_id ||
    challenge.publication_policy_version !== publicationPolicy.version ||
    challenge.publication_policy_sha256 !== canonicalSha256(publicationPolicy)
  ) {
    throw new Error(
      'enrollment challenge does not bind the supplied identity manifest',
    );
  }
  const descriptor = await request.signer.inspect(installation.installation_id);
  if (descriptor === null) {
    throw new Error('installation signing key is unavailable');
  }
  verifyInstallationKeyDescriptor(descriptor);
  if (
    descriptor.installation_id !== installation.installation_id ||
    descriptor.key_id !== installation.signing_key.key_id ||
    descriptor.public_key_spki_der_base64 !==
      installation.signing_key.public_key_spki_der_base64
  ) {
    throw new Error(
      'installation signer does not match the enrollment manifest',
    );
  }
  const proof = await createSignedDocument(
    {
      schema_version: 1,
      kind: 'echo-organization-enrollment-proof',
      challenge_id: challenge.challenge_id,
      challenge_sha256: canonicalSha256(challenge),
      authority_id: challenge.authority_id,
      organization_id: challenge.organization_id,
      principal_id: challenge.principal_id,
      membership_id: challenge.membership_id,
      installation_id: challenge.installation_id,
      installation_key_id: challenge.installation_key_id,
      identity_manifest_id: challenge.identity_manifest_id,
      identity_manifest_sha256: challenge.identity_manifest_sha256,
      publication_policy_id: challenge.publication_policy_id,
      publication_policy_version: challenge.publication_policy_version,
      publication_policy_sha256: challenge.publication_policy_sha256,
    } as const,
    request.signer,
    installation.installation_id,
    installation.signing_key.key_id,
  );
  return validateFederationDocument<OrganizationEnrollmentProofV1>(
    'organization-enrollment-proof',
    proof,
  );
}
