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
  OrganizationAccessLeaseRequestPayloadV1,
  OrganizationAccessLeaseRequestV1,
} from './contracts.js';
import { validateOrganizationAccessLeaseRequest } from './validation.js';

export interface CreateOrganizationAccessLeaseRequestInput {
  request_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  previous_access_state_sha256: Sha256Digest;
  requested_at: string;
}

export function verifyOrganizationAccessLeaseRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationAccessLeaseRequestV1 {
  const request = validateOrganizationAccessLeaseRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: access lease request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export async function createOrganizationAccessLeaseRequest(
  input: CreateOrganizationAccessLeaseRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationAccessLeaseRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationAccessLeaseRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-access-lease-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    previous_access_state_sha256: input.previous_access_state_sha256,
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationAccessLeaseRequest(
    document,
    input.installation_signing_key,
  );
}

export function organizationAccessLeaseRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationAccessLeaseRequest(value, installationSigningKey),
  );
}
