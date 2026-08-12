import {
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import type { CanonicalPayloadSigner } from '@echo-brain/organization-protocol';
import type {
  OrganizationRecentDecisionsRequestPayloadV1,
  OrganizationRecentDecisionsRequestV1,
} from './contracts.js';
import { ORGANIZATION_API_RECENT_DECISIONS_PATH } from './http.js';
import { validateOrganizationRecentDecisionsRequest } from './validation.js';

export interface CreateOrganizationRecentDecisionsRequestInput {
  request_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  requested_at: string;
}

export function verifyOrganizationRecentDecisionsRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecentDecisionsRequestV1 {
  const request = validateOrganizationRecentDecisionsRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: recent decisions request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export async function createOrganizationRecentDecisionsRequest(
  input: CreateOrganizationRecentDecisionsRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationRecentDecisionsRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationRecentDecisionsRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-recent-decisions-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    http_method: 'POST',
    http_path: ORGANIZATION_API_RECENT_DECISIONS_PATH,
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationRecentDecisionsRequest(
    document,
    input.installation_signing_key,
  );
}

export function organizationRecentDecisionsRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationRecentDecisionsRequest(value, installationSigningKey),
  );
}
