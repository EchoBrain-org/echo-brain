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
  OrganizationPermissionCheckRequestPayloadV1,
  OrganizationPermissionCheckRequestV1,
} from './contracts.js';
import {
  organizationPermissionProviderEvent,
  organizationPermissionProviderEventSha256,
  type OrganizationPermissionProviderEventInput,
} from './permission-check-event.js';
import { validateOrganizationPermissionCheckRequest } from './validation.js';

export interface CreateOrganizationPermissionCheckRequestInput
  extends Omit<
    OrganizationPermissionProviderEventInput,
    'installation_key_id'
  > {
  request_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  requested_at: string;
}

export function verifyOrganizationPermissionCheckRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationPermissionCheckRequestV1 {
  const request = validateOrganizationPermissionCheckRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: permission check request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export async function createOrganizationPermissionCheckRequest(
  input: CreateOrganizationPermissionCheckRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationPermissionCheckRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const providerEvent = organizationPermissionProviderEvent({
    ...input,
    installation_key_id: input.installation_signing_key.key_id,
  });
  const payload: OrganizationPermissionCheckRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-permission-check-request',
    request_id: input.request_id,
    ...providerEvent,
    provider_event_sha256:
      organizationPermissionProviderEventSha256(providerEvent),
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationPermissionCheckRequest(
    document,
    input.installation_signing_key,
  );
}

export function organizationPermissionCheckRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationPermissionCheckRequest(value, installationSigningKey),
  );
}
