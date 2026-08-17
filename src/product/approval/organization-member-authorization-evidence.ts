import {
  isCanonicalTimestamp,
  type JsonObject,
} from '@echo-brain/organization-authority/processing/core/index.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const APPROVAL_ID = /^[a-f0-9]{64}$/;
const PREFIXED_UUID_V4 =
  /^(?:oau|org|enr|ins|pcr|prn|mem|bnd|pgr|aud)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'policy_id',
  'policy_contract_sha256',
  'authority_id',
  'organization_id',
  'enrollment_id',
  'installation_id',
  'request_id',
  'approval_id',
  'action',
  'request_sha256',
  'provider_event_sha256',
  'allowed',
  'reason_code',
  'principal_id',
  'membership_id',
  'adapter_binding_id',
  'permission_grant_id',
  'evaluated_at',
  'authorization_audit_event_id',
  'authorization_audit_entry_sha256',
  'release_draft_sha256',
  'approval_presentation_sha256',
  'semantic_intent_sha256',
  'message_presentation_sha256',
] as const);

export type OrganizationMemberAuthorizationEvidence = JsonObject & {
  schema_version: 3;
  kind: 'echo-organization-authorization-evidence';
  policy_id: 'organization-member-readable-v1';
  policy_contract_sha256: string;
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: 'approve';
  request_sha256: string;
  provider_event_sha256: string;
  allowed: true;
  reason_code: 'active_organization_member_readable_notice_v1';
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: string;
  release_draft_sha256: string;
  approval_presentation_sha256: string;
  semantic_intent_sha256: string;
  message_presentation_sha256: string;
};

function plainDataRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error('organization-member authorization evidence must be a plain object');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new Error('organization-member authorization evidence must contain only data fields');
    }
  }
  const record = value as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record).sort();
  const expected = [...EVIDENCE_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error('organization-member authorization evidence has unsupported fields');
  }
  return record;
}

function requireId(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'string' || !PREFIXED_UUID_V4.test(record[field])) {
    throw new Error(`organization-member authorization evidence ${field} is invalid`);
  }
}

function requireDigest(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'string' || !DIGEST.test(record[field])) {
    throw new Error(`organization-member authorization evidence ${field} is invalid`);
  }
}

/**
 * Source-boundary-local restatement of the closed schema-v3 allow proof.
 * Returning a detached, frozen snapshot prevents a provider object from being
 * mutated after validation but before durable resolution.
 */
export function validateOrganizationMemberAuthorizationEvidence(
  value: unknown,
): OrganizationMemberAuthorizationEvidence {
  const record = plainDataRecord(value);
  if (
    record['schema_version'] !== 3 ||
    record['kind'] !== 'echo-organization-authorization-evidence' ||
    record['policy_id'] !== 'organization-member-readable-v1' ||
    record['action'] !== 'approve' ||
    record['allowed'] !== true ||
    record['reason_code'] !== 'active_organization_member_readable_notice_v1'
  ) {
    throw new Error('organization-member authorization evidence literals are invalid');
  }
  for (const field of [
    'authority_id',
    'organization_id',
    'enrollment_id',
    'installation_id',
    'request_id',
    'principal_id',
    'membership_id',
    'adapter_binding_id',
    'permission_grant_id',
    'authorization_audit_event_id',
  ]) {
    requireId(record, field);
  }
  if (
    typeof record['approval_id'] !== 'string' ||
    !APPROVAL_ID.test(record['approval_id'])
  ) {
    throw new Error('organization-member authorization evidence approval_id is invalid');
  }
  for (const field of [
    'policy_contract_sha256',
    'request_sha256',
    'provider_event_sha256',
    'authorization_audit_entry_sha256',
    'release_draft_sha256',
    'approval_presentation_sha256',
    'semantic_intent_sha256',
    'message_presentation_sha256',
  ]) {
    requireDigest(record, field);
  }
  if (!isCanonicalTimestamp(record['evaluated_at'])) {
    throw new Error('organization-member authorization evidence evaluated_at is invalid');
  }
  return Object.freeze({ ...record }) as OrganizationMemberAuthorizationEvidence;
}
