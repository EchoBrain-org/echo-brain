import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';

export interface OrganizationRecordingPolicyV1 {
  readonly schema_version: 1;
  readonly kind: 'organization-recording-policy-v1';
  /**
   * Provenance/routing metadata only. The installation signs this identity,
   * but Authority does not independently attest it, so it is not an
   * authorization-grade ingest condition.
   */
  readonly decision_processor_adapter_instance_id: string;
  /** Authority-owned and enforced through the active binding plus audit. */
  readonly approval_surface_adapter_instance_id: string;
  readonly presentation_mode:
    | 'restricted-reviewer-v1'
    | 'organization-member-readable-v1';
  readonly policy_contract_sha256: `sha256:${string}`;
}

function boundedInstanceId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.includes('\0')
  );
}

/** Closed runtime predicate for the one centrally activated member-v3 gate. */
export function isOrganizationMemberReadableRecordingPolicy(
  value: unknown,
): value is OrganizationRecordingPolicyV1 & {
  readonly presentation_mode: 'organization-member-readable-v1';
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    Object.keys(policy).sort().join(',') ===
      'approval_surface_adapter_instance_id,decision_processor_adapter_instance_id,kind,policy_contract_sha256,presentation_mode,schema_version' &&
    policy.schema_version === 1 &&
    policy.kind === 'organization-recording-policy-v1' &&
    boundedInstanceId(policy.decision_processor_adapter_instance_id) &&
    boundedInstanceId(policy.approval_surface_adapter_instance_id) &&
    policy.presentation_mode === 'organization-member-readable-v1' &&
    policy.policy_contract_sha256 ===
      organizationMemberReadablePolicyContractSha256()
  );
}
