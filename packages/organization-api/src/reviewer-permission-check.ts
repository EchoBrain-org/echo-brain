import {
  canonicalJsonBytes,
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_POLICY_ID,
  REVIEWER_REACTION_PATTERN,
  type CanonicalPayloadSigner,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationReviewerPermissionCheckDecisionV2,
  OrganizationReviewerPermissionCheckRequestPayloadV2,
  OrganizationReviewerPermissionCheckRequestV2,
} from './contracts.js';
import { ORGANIZATION_API_PERMISSION_CHECKS_PATH } from './http.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertPatternString,
  assertString,
  assertTimestamp,
  fail,
  MAX_ORGANIZATION_API_BODY_BYTES,
  validateIntegrity,
} from './validation.js';

/**
 * The exact provider-event preimage for a reviewer approval. It adds the
 * frozen reaction pair, the policy, both content commitments, and the HTTP
 * operation binding to the landed v1 field set.
 */
const REVIEWER_PROVIDER_EVENT_FIELDS = [
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
  'approve_reaction',
  'reject_reaction',
  'policy_id',
  'reviewer_release_draft_sha256',
  'approval_presentation_sha256',
  'http_method',
  'http_path',
] as const;

export type OrganizationReviewerPermissionProviderEventInput = Pick<
  OrganizationReviewerPermissionCheckRequestPayloadV2,
  (typeof REVIEWER_PROVIDER_EVENT_FIELDS)[number]
>;

export function organizationReviewerPermissionProviderEvent(
  input: OrganizationReviewerPermissionProviderEventInput,
): OrganizationReviewerPermissionProviderEventInput {
  return Object.fromEntries(
    REVIEWER_PROVIDER_EVENT_FIELDS.map((field) => [field, input[field]]),
  ) as unknown as OrganizationReviewerPermissionProviderEventInput;
}

export function organizationReviewerPermissionProviderEventSha256(
  input: OrganizationReviewerPermissionProviderEventInput,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 2,
    kind: 'echo-organization-permission-provider-event',
    ...organizationReviewerPermissionProviderEvent(input),
  });
}

const REVIEWER_REQUEST_KEYS = [
  'schema_version',
  'kind',
  'request_id',
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
  'approve_reaction',
  'reject_reaction',
  'policy_id',
  'reviewer_release_draft_sha256',
  'approval_presentation_sha256',
  'provider_event_sha256',
  'requested_at',
  'http_method',
  'http_path',
  'integrity',
] as const;

/**
 * The closed schema-v2 reviewer approval request.
 *
 * It carries content commitments, never content: no draft, title, item text,
 * raw signal id, meeting id, or processing key crosses this wire. Every
 * inherited identifier and Slack coordinate keeps its landed v1 validator.
 */
export function validateOrganizationReviewerPermissionCheckRequest(
  value: unknown,
): OrganizationReviewerPermissionCheckRequestV2 {
  const label = 'reviewer permission check request';
  assertOnlyEnumerableDataProperties(value, label);
  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = canonicalJsonBytes(value);
  } catch (error) {
    fail(`${label} is not canonicalizable`, error);
  }
  if (canonicalBytes.byteLength > MAX_ORGANIZATION_API_BODY_BYTES) {
    fail(`${label} exceeds its canonical byte bound`);
  }
  const record = asRecord(value, label);
  assertExactKeys(record, REVIEWER_REQUEST_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-permission-check-request'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.request_id, 'pcr', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertDigest(record.authority_key_id, `${label} authority_key_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.enrollment_id, 'enr', `${label} enrollment_id`);
  assertId(record.installation_id, 'ins', `${label} installation_id`);
  assertDigest(record.installation_key_id, `${label} installation_key_id`);
  if (
    record.provider !== 'slack' ||
    record.provider_issuer !== 'https://slack.com' ||
    record.provider_tenant_kind !== 'workspace' ||
    record.provider_subject_kind !== 'human_user' ||
    record.adapter_kind !== 'approval-surface'
  ) {
    fail(`${label} provider or adapter kind is unsupported`);
  }
  assertPatternString(
    record.provider_tenant_id,
    `${label} provider_tenant_id`,
    128,
    /^T[A-Z0-9]{2,}$/,
  );
  if (record.provider_enterprise_id !== null) {
    assertPatternString(
      record.provider_enterprise_id,
      `${label} provider_enterprise_id`,
      128,
      /^E[A-Z0-9]{2,}$/,
    );
  }
  assertPatternString(
    record.provider_connection_subject_id,
    `${label} provider_connection_subject_id`,
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.provider_connection_bot_id,
    `${label} provider_connection_bot_id`,
    128,
    /^B[A-Z0-9]{2,}$/,
  );
  if (record.provider_connection_app_id !== null) {
    assertPatternString(
      record.provider_connection_app_id,
      `${label} provider_connection_app_id`,
      128,
      /^A[A-Z0-9]{2,}$/,
    );
  }
  assertPatternString(
    record.provider_subject_id,
    `${label} provider_subject_id`,
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  assertString(record.adapter_id, `${label} adapter_id`, 128);
  assertString(record.adapter_instance_id, `${label} adapter_instance_id`, 128);
  assertString(record.adapter_version, `${label} adapter_version`, 64);
  if (record.action !== 'approve') {
    fail(`${label} schema version 2 authorizes approval only`);
  }
  assertPatternString(
    record.approval_id,
    `${label} approval_id`,
    256,
    /^[0-9a-f]{64}$/,
  );
  assertString(record.channel_id, `${label} channel_id`, 128);
  assertPatternString(
    record.message_ts,
    `${label} message_ts`,
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  for (const field of [
    'reaction_name',
    'approve_reaction',
    'reject_reaction',
  ] as const) {
    assertPatternString(
      record[field],
      `${label} ${field}`,
      64,
      REVIEWER_REACTION_PATTERN,
    );
  }
  if (record.approve_reaction === record.reject_reaction) {
    fail(`${label} approve and reject reactions must be distinct`);
  }
  if (record.reaction_name !== record.approve_reaction) {
    fail(`${label} selected reaction must be the frozen approve reaction`);
  }
  if (record.policy_id !== RESTRICTED_REVIEWER_POLICY_ID) {
    fail(`${label} policy_id is unsupported`);
  }
  assertDigest(
    record.reviewer_release_draft_sha256,
    `${label} reviewer_release_draft_sha256`,
  );
  assertDigest(
    record.approval_presentation_sha256,
    `${label} approval_presentation_sha256`,
  );
  if (
    record.http_method !== 'POST' ||
    record.http_path !== ORGANIZATION_API_PERMISSION_CHECKS_PATH
  ) {
    fail(`${label} HTTP operation is unsupported`);
  }
  assertDigest(record.provider_event_sha256, `${label} provider_event_sha256`);
  const derived = organizationReviewerPermissionProviderEventSha256(
    record as unknown as OrganizationReviewerPermissionCheckRequestV2,
  );
  if (record.provider_event_sha256 !== derived) {
    fail(`${label} provider_event_sha256 does not match its event`);
  }
  assertTimestamp(record.requested_at, `${label} requested_at`);
  const integrity = validateIntegrity(record.integrity, label);
  if (integrity.key_id !== record.installation_key_id) {
    fail(`${label} signature key does not match installation key`);
  }
  return {
    ...record,
    integrity,
  } as unknown as OrganizationReviewerPermissionCheckRequestV2;
}

export function verifyOrganizationReviewerPermissionCheckRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationReviewerPermissionCheckRequestV2 {
  const request = validateOrganizationReviewerPermissionCheckRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: reviewer permission check request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export function organizationReviewerPermissionCheckRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationReviewerPermissionCheckRequest(
      value,
      installationSigningKey,
    ),
  );
}

export interface CreateOrganizationReviewerPermissionCheckRequestInput
  extends Omit<
    OrganizationReviewerPermissionProviderEventInput,
    'installation_key_id' | 'http_method' | 'http_path' | 'action' | 'policy_id'
  > {
  request_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  requested_at: string;
}

export async function createOrganizationReviewerPermissionCheckRequest(
  input: CreateOrganizationReviewerPermissionCheckRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationReviewerPermissionCheckRequestV2> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const providerEvent = organizationReviewerPermissionProviderEvent({
    ...input,
    installation_key_id: input.installation_signing_key.key_id,
    action: 'approve',
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  });
  const payload: OrganizationReviewerPermissionCheckRequestPayloadV2 = {
    schema_version: 2,
    kind: 'echo-organization-permission-check-request',
    request_id: input.request_id,
    ...providerEvent,
    provider_event_sha256:
      organizationReviewerPermissionProviderEventSha256(providerEvent),
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationReviewerPermissionCheckRequest(
    document,
    input.installation_signing_key,
  );
}

/**
 * Re-exported so member code bound to the API layer has one source of truth
 * for the reviewer reason without importing the protocol package directly.
 */
export { RESTRICTED_REVIEWER_ALLOW_REASON_CODE };

export const REVIEWER_PERMISSION_DENIAL_REASON_CODES = Object.freeze([
  'installation_inactive',
  'no_active_link_binding_or_grant',
  'provider_unavailable',
  'provider_identity_mismatch',
  'provider_reaction_not_observed',
  'target_membership_inactive',
] as const);

export type OrganizationReviewerPermissionDenialReasonCodeV2 =
  (typeof REVIEWER_PERMISSION_DENIAL_REASON_CODES)[number];

const REVIEWER_DECISION_KEYS = [
  'schema_version',
  'kind',
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
  'reviewer_release_draft_sha256',
  'approval_presentation_sha256',
  'semantic_intent_sha256',
  'message_presentation_sha256',
] as const;

const REVIEWER_DECISION_PROOF_FIELDS = [
  'authorization_audit_event_id',
  'authorization_audit_entry_sha256',
  'reviewer_release_draft_sha256',
  'approval_presentation_sha256',
  'semantic_intent_sha256',
  'message_presentation_sha256',
] as const;

/**
 * The closed schema-v2 decision. An allow carries every proof field and the one
 * reviewer reason; a denial nulls all six proof fields and all four
 * actor/binding/grant identifiers and names one of the closed denial reasons.
 */
export function validateOrganizationReviewerPermissionCheckDecision(
  value: unknown,
): OrganizationReviewerPermissionCheckDecisionV2 {
  const label = 'reviewer permission check decision';
  assertOnlyEnumerableDataProperties(value, label);
  const record = asRecord(value, label);
  assertExactKeys(record, REVIEWER_DECISION_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-permission-check-decision'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  assertDigest(record.request_sha256, `${label} request_sha256`);
  assertDigest(record.provider_event_sha256, `${label} provider_event_sha256`);
  if (typeof record.allowed !== 'boolean') {
    fail(`${label} allowed must be boolean`);
  }
  assertTimestamp(record.evaluated_at, `${label} evaluated_at`);

  if (record.allowed) {
    if (record.reason_code !== RESTRICTED_REVIEWER_ALLOW_REASON_CODE) {
      fail(`${label} allow reason_code is unsupported`);
    }
    assertId(record.principal_id, 'prn', `${label} principal_id`);
    assertId(record.membership_id, 'mem', `${label} membership_id`);
    assertId(record.adapter_binding_id, 'bnd', `${label} adapter_binding_id`);
    assertId(
      record.permission_grant_id,
      'pgr',
      `${label} permission_grant_id`,
    );
    assertId(
      record.authorization_audit_event_id,
      'aud',
      `${label} authorization_audit_event_id`,
    );
    for (const field of REVIEWER_DECISION_PROOF_FIELDS) {
      if (field === 'authorization_audit_event_id') continue;
      assertDigest(record[field], `${label} ${field}`);
    }
    return record as unknown as OrganizationReviewerPermissionCheckDecisionV2;
  }

  if (
    typeof record.reason_code !== 'string' ||
    !REVIEWER_PERMISSION_DENIAL_REASON_CODES.includes(
      record.reason_code as OrganizationReviewerPermissionDenialReasonCodeV2,
    )
  ) {
    fail(`${label} denial reason_code is unsupported`);
  }
  for (const field of [
    'principal_id',
    'membership_id',
    'adapter_binding_id',
    'permission_grant_id',
    ...REVIEWER_DECISION_PROOF_FIELDS,
  ] as const) {
    if (record[field] !== null) {
      fail(`${label} denial must null every proof and actor field`);
    }
  }
  return record as unknown as OrganizationReviewerPermissionCheckDecisionV2;
}
