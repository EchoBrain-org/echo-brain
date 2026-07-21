import type {
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../../../product/federation/contracts.js';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentRequestV1,
} from '../contracts.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from '../../../product/federation/foundation/canonical-json.js';
import type { InstallationSigner } from '../../../product/federation/foundation/installation-signer.js';
import { verifyInstallationKeyDescriptor } from '../../../product/federation/foundation/installation-signer.js';
import {
  createSignedDocument,
  verifySignedDocument,
} from '../../../product/federation/foundation/signed-document.js';
import {
  assertFederationDocumentSize,
  type FederationSchemaKind,
  validateFederationDocument,
} from '../../../product/federation/schema-validation.js';
import { validateN2Document } from '../schema-validation.js';
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

export function organizationEnrollmentGrantSha256(
  secret: string,
): Sha256Digest {
  if (typeof secret !== 'string') {
    throw new Error('organization enrollment grant must be text');
  }
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== secret) {
    throw new Error(
      'organization enrollment grant must be canonical base64 for 32 bytes',
    );
  }
  return sha256Digest(decoded);
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

export interface CreateOrganizationEnrollmentRequestInput {
  authority: OrganizationAuthorityDescriptorV1;
  manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
  enrollment_grant: string;
  signer: InstallationSigner;
}

/** Signs one exact enrollment request with the installation key being enrolled. */
export async function createOrganizationEnrollmentRequest(
  input: CreateOrganizationEnrollmentRequestInput,
): Promise<OrganizationEnrollmentRequestV1> {
  const manifest = validatedSnapshot<LocalIdentityManifestV1>(
    'local-identity-manifest',
    input.manifest,
    'organization enrollment identity manifest',
  );
  const publicationPolicy = validatedSnapshot<PublicationPolicyV1>(
    'publication-policy',
    input.publication_policy,
    'organization enrollment publication policy',
  );
  verifyOrganizationAuthorityDescriptor(input.authority);
  const manifestPublicKey = verifiedManifestPublicKey(manifest);
  verifySignedDocument(
    publicationPolicy,
    manifestPublicKey,
    manifest.installation.signing_key.key_id,
  );

  const installation = manifest.installation;
  if (
    input.authority.organization_id !== manifest.organization.organization_id ||
    publicationPolicy.organization_id !==
      manifest.organization.organization_id ||
    publicationPolicy.identity_manifest_id !== manifest.manifest_id ||
    publicationPolicy.issued_by.installation_id !==
      installation.installation_id ||
    publicationPolicy.issued_by.key_id !== installation.signing_key.key_id ||
    publicationPolicy.effective_at < manifest.created_at
  ) {
    throw new Error(
      'organization enrollment material has inconsistent identity coordinates',
    );
  }
  const descriptor = await input.signer.inspect(installation.installation_id);
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
    throw new Error('installation signer does not match enrollment manifest');
  }

  const request = await createSignedDocument(
    {
      schema_version: 1,
      kind: 'echo-organization-enrollment-request',
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(
        input.enrollment_grant,
      ),
      authority_id: input.authority.authority_id,
      organization_id: input.authority.organization_id,
      principal_id: manifest.principal.principal_id,
      membership_id: manifest.membership.membership_id,
      installation_id: installation.installation_id,
      installation_key_id: installation.signing_key.key_id,
      identity_manifest_id: manifest.manifest_id,
      identity_manifest_sha256: canonicalSha256(manifest),
      publication_policy_id: publicationPolicy.policy_id,
      publication_policy_version: publicationPolicy.version,
      publication_policy_sha256: canonicalSha256(publicationPolicy),
    } as const,
    input.signer,
    installation.installation_id,
    installation.signing_key.key_id,
  );
  return validateN2Document<OrganizationEnrollmentRequestV1>(
    'organization-enrollment-request',
    request,
  );
}
