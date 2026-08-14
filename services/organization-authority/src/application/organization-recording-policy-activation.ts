import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalSha256,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationRecordingPolicyV1 } from './organization-recording-policy.js';

export const ORGANIZATION_MEMBER_RECORDING_ACTIVATION_COMMAND_KIND =
  'echo-organization-member-recording-activation-command' as const;
export const ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION =
  'configuration.organization_member_recording_activated' as const;

const COMMAND_ID =
  /^rpa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_INSTANCE_ID_LENGTH = 128;

export interface OrganizationMemberRecordingActivationCommandV1 {
  readonly schema_version: 1;
  readonly kind: typeof ORGANIZATION_MEMBER_RECORDING_ACTIVATION_COMMAND_KIND;
  readonly command_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly initialized_runtime_config_sha256: Sha256Digest;
  readonly initialization_manifest_sha256: Sha256Digest;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly target_policy: OrganizationRecordingPolicyV1 & {
    readonly presentation_mode: 'organization-member-readable-v1';
  };
  readonly requested_at: string;
  readonly reason: string;
}

export interface StoredOrganizationMemberRecordingActivation {
  readonly command: OrganizationMemberRecordingActivationCommandV1;
  readonly command_sha256: Sha256Digest;
  readonly activated_at: string;
  readonly activation_sha256: Sha256Digest;
  readonly audit_sequence: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
  return value as Sha256Digest;
}

function instanceId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_INSTANCE_ID_LENGTH ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a bounded non-empty identifier`);
  }
  return value;
}

function targetPolicy(value: unknown): OrganizationMemberRecordingActivationCommandV1['target_policy'] {
  const policy = object(value, 'organization-member recording target policy');
  exactKeys(
    policy,
    [
      'schema_version',
      'kind',
      'decision_processor_adapter_instance_id',
      'approval_surface_adapter_instance_id',
      'presentation_mode',
      'policy_contract_sha256',
    ],
    'organization-member recording target policy',
  );
  if (
    policy.schema_version !== 1 ||
    policy.kind !== 'organization-recording-policy-v1' ||
    policy.presentation_mode !== 'organization-member-readable-v1' ||
    policy.policy_contract_sha256 !==
      organizationMemberReadablePolicyContractSha256()
  ) {
    throw new Error(
      'organization-member recording target policy is unsupported',
    );
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'organization-recording-policy-v1',
    decision_processor_adapter_instance_id: instanceId(
      policy.decision_processor_adapter_instance_id,
      'decision processor adapter instance ID',
    ),
    approval_surface_adapter_instance_id: instanceId(
      policy.approval_surface_adapter_instance_id,
      'approval surface adapter instance ID',
    ),
    presentation_mode: 'organization-member-readable-v1',
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
  });
}

export function validateOrganizationMemberRecordingActivationCommand(
  value: unknown,
  binding?: { readonly authority_id: string; readonly organization_id: string },
): OrganizationMemberRecordingActivationCommandV1 {
  const command = object(value, 'organization-member recording activation command');
  exactKeys(
    command,
    [
      'schema_version',
      'kind',
      'command_id',
      'authority_id',
      'organization_id',
      'initialized_runtime_config_sha256',
      'initialization_manifest_sha256',
      'owner_principal_id',
      'owner_membership_id',
      'target_policy',
      'requested_at',
      'reason',
    ],
    'organization-member recording activation command',
  );
  if (
    command.schema_version !== 1 ||
    command.kind !== ORGANIZATION_MEMBER_RECORDING_ACTIVATION_COMMAND_KIND ||
    typeof command.command_id !== 'string' ||
    !COMMAND_ID.test(command.command_id) ||
    typeof command.authority_id !== 'string' ||
    typeof command.organization_id !== 'string' ||
    typeof command.owner_principal_id !== 'string' ||
    typeof command.owner_membership_id !== 'string' ||
    typeof command.requested_at !== 'string'
  ) {
    throw new Error('organization-member recording activation identity is invalid');
  }
  assertFederationId(command.authority_id, 'oau', 'activation authority ID');
  assertFederationId(command.organization_id, 'org', 'activation organization ID');
  assertFederationId(command.owner_principal_id, 'prn', 'activation owner principal ID');
  assertFederationId(command.owner_membership_id, 'mem', 'activation owner membership ID');
  assertUtcMillisecondTimestamp(command.requested_at, 'activation requested_at');
  if (
    binding !== undefined &&
    (command.authority_id !== binding.authority_id ||
      command.organization_id !== binding.organization_id)
  ) {
    throw new Error('organization-member recording activation differs from configured authority');
  }
  if (
    typeof command.reason !== 'string' ||
    command.reason.trim() !== command.reason ||
    command.reason.normalize('NFC') !== command.reason ||
    new TextEncoder().encode(command.reason).byteLength < 1 ||
    new TextEncoder().encode(command.reason).byteLength > 500 ||
    /\p{Cc}/u.test(command.reason)
  ) {
    throw new Error('organization-member recording activation reason is invalid');
  }
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_MEMBER_RECORDING_ACTIVATION_COMMAND_KIND,
    command_id: command.command_id,
    authority_id: command.authority_id,
    organization_id: command.organization_id,
    initialized_runtime_config_sha256: digest(
      command.initialized_runtime_config_sha256,
      'initialized runtime config digest',
    ),
    initialization_manifest_sha256: digest(
      command.initialization_manifest_sha256,
      'initialization manifest digest',
    ),
    owner_principal_id: command.owner_principal_id,
    owner_membership_id: command.owner_membership_id,
    target_policy: targetPolicy(command.target_policy),
    requested_at: command.requested_at,
    reason: command.reason,
  });
}

export function organizationMemberRecordingActivationCommandSha256(
  command: OrganizationMemberRecordingActivationCommandV1,
): Sha256Digest {
  return canonicalSha256(command);
}

export function assertOrganizationMemberRecordingActivationFresh(
  command: OrganizationMemberRecordingActivationCommandV1,
  now: string,
): void {
  assertUtcMillisecondTimestamp(now, 'organization-member recording activation time');
  if (Math.abs(Date.parse(now) - Date.parse(command.requested_at)) > 5 * 60_000) {
    throw new Error('organization-member recording activation is outside five minutes');
  }
}

export function organizationMemberRecordingActivationSha256(input: {
  readonly command_sha256: Sha256Digest;
  readonly activated_at: string;
  readonly audit_sequence: number;
}): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'echo-organization-member-recording-activation',
    ...input,
  });
}
