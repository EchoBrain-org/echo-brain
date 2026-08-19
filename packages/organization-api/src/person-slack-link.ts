import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import type {
  OrganizationPersonSlackLinkBeginRequestV2,
  OrganizationPersonSlackLinkBeginResponseV2,
  OrganizationPersonSlackLinkCompleteRequestV2,
  OrganizationPersonSlackLinkResultV2,
} from './contracts.js';
import {
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
} from './http.js';
import { isCanonicalOrganizationSlackLinkChallengeCode } from './slack-link-challenge-code.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertPatternString,
  assertTimestamp,
  fail,
} from './validation.js';

const PERSON_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'authority_id',
  'organization_id',
  'subject_principal_id',
  'http_method',
  'http_path',
] as const;

function validatePersonIdentity(
  record: Record<string, unknown>,
  label: string,
  prefix: 'psb' | 'psc',
): void {
  assertId(record.request_id, prefix, `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.subject_principal_id, 'prn', `${label} subject_principal_id`);
  if (record.http_method !== 'POST') fail(`${label} HTTP method is unsupported`);
}

export function validateOrganizationPersonSlackLinkBeginRequest(
  value: unknown,
): OrganizationPersonSlackLinkBeginRequestV2 {
  const label = 'Person Slack link begin request';
  const record = asRecord(value, label);
  assertExactKeys(record, [...PERSON_KEYS, 'challenge_code_sha256'], label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-begin-request' ||
    record.http_path !== ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH
  ) {
    fail(`${label} version, kind, or path is unsupported`);
  }
  validatePersonIdentity(record, label, 'psb');
  assertDigest(record.challenge_code_sha256, `${label} challenge_code_sha256`);
  return record as unknown as OrganizationPersonSlackLinkBeginRequestV2;
}

export function validateOrganizationPersonSlackLinkCompleteRequest(
  value: unknown,
): OrganizationPersonSlackLinkCompleteRequestV2 {
  const label = 'Person Slack link complete request';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      ...PERSON_KEYS,
      'challenge_attempt_id',
      'challenge_message_ts',
      'challenge_code',
    ],
    label,
  );
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-complete-request' ||
    record.http_path !== ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH
  ) {
    fail(`${label} version, kind, or path is unsupported`);
  }
  validatePersonIdentity(record, label, 'psc');
  assertId(record.challenge_attempt_id, 'cat', `${label} challenge_attempt_id`);
  assertPatternString(
    record.challenge_message_ts,
    `${label} challenge_message_ts`,
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  if (!isCanonicalOrganizationSlackLinkChallengeCode(record.challenge_code)) {
    fail(`${label} challenge_code must be canonical unpadded base64url for exactly 32 bytes`);
  }
  return record as unknown as OrganizationPersonSlackLinkCompleteRequestV2;
}

export function validateOrganizationPersonSlackLinkBeginResponse(
  value: unknown,
): OrganizationPersonSlackLinkBeginResponseV2 {
  const label = 'Person Slack link begin response';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'challenge_attempt_id',
      'provider',
      'provider_tenant_id',
      'channel_id',
      'challenge_message_ts',
      'expires_at',
    ],
    label,
  );
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-begin-response' ||
    record.provider !== 'slack'
  ) {
    fail(`${label} version, kind, or provider is unsupported`);
  }
  assertId(record.challenge_attempt_id, 'cat', `${label} challenge_attempt_id`);
  assertPatternString(record.provider_tenant_id, `${label} provider_tenant_id`, 128, /^T[A-Z0-9]{2,}$/);
  assertPatternString(record.channel_id, `${label} channel_id`, 128, /^C[A-Z0-9]{2,}$/);
  assertPatternString(record.challenge_message_ts, `${label} challenge_message_ts`, 64, /^\d{1,16}\.\d{1,16}$/);
  assertTimestamp(record.expires_at, `${label} expires_at`);
  return record as unknown as OrganizationPersonSlackLinkBeginResponseV2;
}

export function validateOrganizationPersonSlackLinkResult(
  value: unknown,
): OrganizationPersonSlackLinkResultV2 {
  const label = 'Person Slack link result';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'identity_link_id',
      'connection_id',
      'organization_id',
      'principal_id',
      'membership_id',
      'provider',
      'provider_tenant_id',
      'provider_subject_id',
      'channel_id',
      'linked_at',
      'identity_link_created',
    ],
    label,
  );
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-result' ||
    record.provider !== 'slack'
  ) {
    fail(`${label} version, kind, or provider is unsupported`);
  }
  assertId(record.identity_link_id, 'clm', `${label} identity_link_id`);
  assertId(record.connection_id, 'con', `${label} connection_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.principal_id, 'prn', `${label} principal_id`);
  assertId(record.membership_id, 'mem', `${label} membership_id`);
  assertPatternString(record.provider_tenant_id, `${label} provider_tenant_id`, 128, /^T[A-Z0-9]{2,}$/);
  assertPatternString(record.provider_subject_id, `${label} provider_subject_id`, 128, /^[UW][A-Z0-9]{2,}$/);
  assertPatternString(record.channel_id, `${label} channel_id`, 128, /^C[A-Z0-9]{2,}$/);
  assertTimestamp(record.linked_at, `${label} linked_at`);
  if (typeof record.identity_link_created !== 'boolean') {
    fail(`${label} identity_link_created must be a boolean`);
  }
  return record as unknown as OrganizationPersonSlackLinkResultV2;
}

export function canonicalOrganizationPersonSlackLinkBeginRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(validateOrganizationPersonSlackLinkBeginRequest(value));
}

export function canonicalOrganizationPersonSlackLinkCompleteRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(validateOrganizationPersonSlackLinkCompleteRequest(value));
}
