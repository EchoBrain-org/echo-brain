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
  OrganizationSlackLinkBeginRequestPayloadV1,
  OrganizationSlackLinkBeginRequestV1,
  OrganizationSlackLinkCompleteRequestPayloadV1,
  OrganizationSlackLinkCompleteRequestV1,
} from './contracts.js';
import {
  validateOrganizationSlackLinkBeginRequest,
  validateOrganizationSlackLinkCompleteRequest,
} from './validation.js';

interface OrganizationSlackLinkRequestIdentityInput {
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  requested_at: string;
}

export interface CreateOrganizationSlackLinkBeginRequestInput
  extends OrganizationSlackLinkRequestIdentityInput {
  request_id: string;
  challenge_code_sha256: Sha256Digest;
}

export interface CreateOrganizationSlackLinkCompleteRequestInput
  extends OrganizationSlackLinkRequestIdentityInput {
  request_id: string;
  challenge_attempt_id: string;
  challenge_message_ts: string;
  challenge_code: string;
  expected_provider_subject_id: string;
  adapter_id: 'slack-reactions';
  adapter_instance_id: string;
  adapter_version: string;
}

export function verifyOrganizationSlackLinkBeginRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationSlackLinkBeginRequestV1 {
  const request = validateOrganizationSlackLinkBeginRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: Slack link begin request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export async function createOrganizationSlackLinkBeginRequest(
  input: CreateOrganizationSlackLinkBeginRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationSlackLinkBeginRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationSlackLinkBeginRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-slack-link-begin-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    challenge_code_sha256: input.challenge_code_sha256,
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationSlackLinkBeginRequest(
    document,
    input.installation_signing_key,
  );
}

export function organizationSlackLinkBeginRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationSlackLinkBeginRequest(value, installationSigningKey),
  );
}

export function verifyOrganizationSlackLinkCompleteRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationSlackLinkCompleteRequestV1 {
  const request = validateOrganizationSlackLinkCompleteRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: Slack link complete request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export async function createOrganizationSlackLinkCompleteRequest(
  input: CreateOrganizationSlackLinkCompleteRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationSlackLinkCompleteRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationSlackLinkCompleteRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-slack-link-complete-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    challenge_attempt_id: input.challenge_attempt_id,
    challenge_message_ts: input.challenge_message_ts,
    challenge_code: input.challenge_code,
    expected_provider_subject_id: input.expected_provider_subject_id,
    adapter_id: input.adapter_id,
    adapter_instance_id: input.adapter_instance_id,
    adapter_version: input.adapter_version,
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationSlackLinkCompleteRequest(
    document,
    input.installation_signing_key,
  );
}

export function organizationSlackLinkCompleteRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationSlackLinkCompleteRequest(value, installationSigningKey),
  );
}
