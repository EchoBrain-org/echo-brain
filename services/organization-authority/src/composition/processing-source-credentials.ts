import { canonicalSha256 } from '@echo-brain/federation-protocol';

/** Fixed private-file names for the one Authority-owned Granola source. */
export const AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME =
  'granola-organization-api-key';
export const AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME =
  'granola-organization-owner-email';
export const AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME =
  'granola-organization-credential-scope';
export const AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE =
  'aws-secrets-manager:us-west-2:echo/org1-prod/granola-organization-source:SecretString:api_key';

/**
 * The durable source binding records the logical secret reference, never the
 * secret. Rotation behind this reference therefore does not fork the source.
 */
export function authorityProcessingCredentialReferenceSha256(
  credentialReference: string,
): `sha256:${string}` {
  return canonicalSha256({
    schema_version: 1,
    kind: 'authority-processing-organization-credential-reference-v1',
    source_adapter_id: 'granola',
    credential_scope: 'organization',
    credential_reference: credentialReference,
  });
}
