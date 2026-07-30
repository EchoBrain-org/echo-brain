import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { OrganizationPermissionCheckRequestPayloadV1 } from './contracts.js';

const PROVIDER_EVENT_FIELDS = [
  'authority_id',
  'authority_key_id',
  'organization_id',
  'enrollment_id',
  'installation_id',
  'installation_key_id',
  'provider',
  'provider_issuer',
  'provider_tenant_kind',
  'provider_tenant_id',
  'provider_enterprise_id',
  'provider_connection_subject_id',
  'provider_connection_bot_id',
  'provider_connection_app_id',
  'provider_subject_kind',
  'provider_subject_id',
  'adapter_kind',
  'adapter_id',
  'adapter_instance_id',
  'adapter_version',
  'action',
  'approval_id',
  'channel_id',
  'message_ts',
  'reaction_name',
] as const;

export type OrganizationPermissionProviderEventInput = Pick<
  OrganizationPermissionCheckRequestPayloadV1,
  (typeof PROVIDER_EVENT_FIELDS)[number]
>;

export function organizationPermissionProviderEvent(
  input: OrganizationPermissionProviderEventInput,
): OrganizationPermissionProviderEventInput {
  return Object.fromEntries(
    PROVIDER_EVENT_FIELDS.map((field) => [field, input[field]]),
  ) as unknown as OrganizationPermissionProviderEventInput;
}

/**
 * Names the exact provider action independently of request retries and clocks.
 * Every provider, action, resource, and adapter-binding field participates.
 */
export function organizationPermissionProviderEventSha256(
  input: OrganizationPermissionProviderEventInput,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'echo-organization-permission-provider-event',
    ...organizationPermissionProviderEvent(input),
  });
}
